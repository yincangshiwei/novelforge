const fs = require('node:fs/promises')
const path = require('node:path')
const assert = require('node:assert/strict')
const { createRequire } = require('node:module')

// 从 builder 的真实依赖位置解析，兼容 pnpm 非扁平 node_modules。
const builderRequire = createRequire(require.resolve('electron-builder'))
const appBuilderRequire = createRequire(builderRequire.resolve('app-builder-lib'))
const ResEdit = appBuilderRequire('resedit')

function numericVersion(value) {
  const match = /^(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:\.(\d+))?(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.exec(value)
  if (!match) throw new Error(`无法转换 Windows 数字版本：${value}`)
  const parts = match.slice(1, 5).map(part => Number(part || 0))
  if (parts.some(part => !Number.isInteger(part) || part > 65535)) {
    throw new Error(`Windows 数字版本必须在 0–65535 范围内：${value}`)
  }
  return parts
}

function resourceSnapshot(entries) {
  return entries.filter(entry => ![3, 14, 16].includes(entry.type)).map(entry => ({
    type: entry.type, id: entry.id, lang: entry.lang, codepage: entry.codepage,
    bin: Buffer.from(entry.bin).toString('base64'),
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
}

function editExecutable(input, iconBuffer, appInfo, winOptions, requireIntegrity) {
  // 不忽略证书：已签名输入应报错，不静默破坏 Authenticode。
  const executable = ResEdit.NtExecutable.from(input)
  const resources = ResEdit.NtExecutableResource.from(executable)
  const preserved = resourceSnapshot(resources.entries)
  if (requireIntegrity && !resources.entries.some(entry =>
    entry.type === 'INTEGRITY' && entry.id === 'ELECTRONASAR')) {
    throw new Error('ASAR INTEGRITY 资源缺失；停止编辑，不关闭完整性')
  }
  const icons = ResEdit.Data.IconFile.from(iconBuffer).icons.map(item => item.data)
  if (!icons.length) throw new Error('配置的 ICO 没有图像')
  const groups = ResEdit.Resource.IconGroupEntry.fromEntries(resources.entries)
  if (!groups.length) throw new Error('Electron EXE 缺少图标组')
  for (const group of groups) {
    ResEdit.Resource.IconGroupEntry.replaceIconsForResource(resources.entries, group.id, group.lang, icons)
  }

  const fileVersion = appInfo.shortVersion || appInfo.buildVersion
  const productVersion = appInfo.shortVersionWindows || appInfo.getVersionInWeirdWindowsForm()
  const fileParts = numericVersion(fileVersion)
  const productParts = numericVersion(productVersion)
  const strings = {
    FileDescription: appInfo.productName,
    ProductName: appInfo.productName,
    LegalCopyright: appInfo.copyright,
    InternalName: appInfo.productFilename,
    OriginalFilename: '',
    FileVersion: fileVersion,
    ProductVersion: productVersion,
  }
  if (appInfo.companyName != null) strings.CompanyName = appInfo.companyName
  if (winOptions.legalTrademarks != null) strings.LegalTrademarks = winOptions.legalTrademarks
  const versions = ResEdit.Resource.VersionInfo.fromEntries(resources.entries)
  if (!versions.length) throw new Error('Electron EXE 缺少版本资源')
  for (const version of versions) {
    const languages = version.getAllLanguagesForStringValues()
    if (!languages.length) throw new Error('版本资源缺少字符串语言表')
    // 直接更新固定字段，避免辅助 API 自动增加 1200 codepage 语言表。
    Object.assign(version.fixedInfo, {
      fileVersionMS: ((fileParts[0] << 16) | fileParts[1]) >>> 0,
      fileVersionLS: ((fileParts[2] << 16) | fileParts[3]) >>> 0,
      productVersionMS: ((productParts[0] << 16) | productParts[1]) >>> 0,
      productVersionLS: ((productParts[2] << 16) | productParts[3]) >>> 0,
    })
    for (const language of languages) version.setStringValues(language, strings, false)
    version.outputToResourceEntries(resources.entries)
  }
  resources.outputResource(executable)
  const output = Buffer.from(executable.generate())
  const checked = ResEdit.NtExecutableResource.from(ResEdit.NtExecutable.from(output))
  // 写磁盘前重新解析，确保完整性、manifest 等非目标资源逐字节保留。
  assert.deepEqual(resourceSnapshot(checked.entries), preserved)
  for (const version of ResEdit.Resource.VersionInfo.fromEntries(checked.entries)) {
    assert.equal(version.fixedInfo.fileVersionMS >>> 0, ((fileParts[0] << 16) | fileParts[1]) >>> 0)
    assert.equal(version.fixedInfo.fileVersionLS >>> 0, ((fileParts[2] << 16) | fileParts[3]) >>> 0)
    assert.equal(version.fixedInfo.productVersionMS >>> 0, ((productParts[0] << 16) | productParts[1]) >>> 0)
    assert.equal(version.fixedInfo.productVersionLS >>> 0, ((productParts[2] << 16) | productParts[3]) >>> 0)
    for (const language of version.getAllLanguagesForStringValues()) {
      const actual = version.getStringValues(language)
      for (const [key, value] of Object.entries(strings)) assert.equal(actual[key], value)
    }
  }
  const expectedIcons = icons.map(icon => Buffer.from(icon.isIcon() ? icon.generate() : icon.bin))
  const checkedGroups = ResEdit.Resource.IconGroupEntry.fromEntries(checked.entries)
  assert.equal(checkedGroups.length, groups.length)
  for (const group of checkedGroups) {
    const actual = group.getIconItemsFromEntries(checked.entries)
    assert.deepEqual(actual.map(icon => Buffer.from(icon.isIcon() ? icon.generate() : icon.bin)), expectedIcons)
  }
  return output
}

async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return
  const { packager, appOutDir } = context
  const options = packager.platformSpecificBuildOptions
  if (options.signAndEditExecutable !== false) {
    throw new Error('此 hook 必须与 win.signAndEditExecutable: false 配套，避免自动 rcedit')
  }
  if (packager.config.forceCodeSigning) {
    throw new Error('此资源 hook 不替代代码签名；forceCodeSigning 需要独立签名流程')
  }
  if (options.requestedExecutionLevel && options.requestedExecutionLevel !== 'asInvoker') {
    throw new Error('此 hook 保留原 manifest，不支持更改 requestedExecutionLevel')
  }
  const iconPath = await packager.getIconPath()
  if (!iconPath) throw new Error('未找到配置的 Windows ICO')
  const file = path.join(appOutDir, `${packager.appInfo.productFilename}.exe`)
  const [input, iconBuffer] = await Promise.all([fs.readFile(file), fs.readFile(iconPath)])
  const output = editExecutable(input, iconBuffer, packager.appInfo, options, packager.config.asar !== false)
  await fs.writeFile(file, output)
}

module.exports = afterPack
module.exports.editExecutable = editExecutable
module.exports.numericVersion = numericVersion
