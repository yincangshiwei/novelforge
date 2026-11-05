import type { PromptTemplate } from "../prompt-templates";

export const charactersPrompts: PromptTemplate[] = [
  {
    key: 'update_character_cards',
    name: '更新角色卡动态状态',
    description: '定稿后分析章节内容，以 Markdown 表格返回角色状态变化，用于自动更新角色卡',
    systemRole: '你是一位严谨的小说角色档案管理员，擅长追踪角色多维状态变化。',
    variables: {
      chapter_content: '章节正文内容',
      chapter_number: '章节编号',
      existing_cards_json: '现有角色卡 JSON 数组（包含 name/role 等基础信息）',
    },
    content: `请根据章节内容，以 Markdown 表格格式返回在本章中发生状态变化的角色的最新状态。

【本章内容（第{{chapter_number}}章）】
{{chapter_content}}

【现有角色卡（基础信息）】
{{existing_cards_json}}

---

【任务要求】
1. 分析并在 \`updates\` 中提取已有角色（从提供的现有角色卡中找）发生状态变化的信息。
2. 在 \`newCharacters\` 中提取新出场且有明确剧情作用的具名人物，排除无名路人和背景群体。tier 独立于 role：1主要角色（长期主线与人物线），2关键配角（阶段事件/支线关键作用），3次要角色（局部作用）；反派不自动为1。
3. \`currentState\` 字段说明：
   - location: 当前所在位置/阵营（字符串）
   - powerLevel: 修为境界/能力等级（字符串）
   - physicalState: 身体状态，包括伤势/BUFF/外貌变化（字符串）
   - mentalState: 心理状态，当前愿望/恐惧/心态（字符串）
   - keyItems: 当前持有的关键道具/资源（字符串）
   - recentEvents: 本章发生的最重要事件（字符串，50字以内）
   - updatedAtChapter: 固定填写 {{chapter_number}}（数字）
4. \`tags\`：角色的标签（如"天才少年、复仇者、剑修"），多个标签用逗号分隔；没有新标签可写"无"。
5. \`motivation\`：角色当前的核心动机/渴望（如果本章动机发生变化或本章揭示了动机，更新它；不变可写"无"）。
6. NEW 表格额外填写 \`appearance\`（标志性外貌特征）与 \`personality\`（性格特点）——新角色登记时不得留空，外貌必须基于出场描写充实一段。
7. 角色名必须与已有角色完全一致，严禁附加括号别名或身份注释（如「老乞丐（前魂师）」）；新角色名同样不得含括号，别名信息放入「介绍」列。

【输出格式（Markdown 表格）】
严格按以下表格输出（不要 JSON，不要代码块包裹）：

### UPDATES（状态变化的已有角色）
| name | location | powerLevel | physicalState | mentalState | keyItems | recentEvents | tags | motivation |
|------|----------|------------|---------------|-------------|----------|-------------|------|------------|
| 角色名 | 位置 | 境界 | 身体状态 | 心理状态 | 道具 | 本章事件(50字内) | 标签(逗号分隔) | 当前核心动机 |

### NEW（新出场角色）
| name | role | tier | location | powerLevel | physicalState | mentalState | keyItems | recentEvents | tags | motivation | appearance | personality |
|------|------|------|----------|------------|---------------|-------------|----------|-------------|------|------------|------------|-------------|
| 新角色名 | protagonist/antagonist/supporting/minor | 1/2/3 | 位置 | 境界 | 状态 | 心理 | 道具 | 介绍 | 标签 | 动机 | 外貌 | 性格 |

注意：updatedAtChapter 固定为 {{chapter_number}}。老角色只输出状态变化了的；tags/motivation 无变化填"无"。如果本章无任何角色状态变化且无新角色，输出"无变化"。`,
  },
  {
    key: 'extract_initial_characters',
    name: '提取初始角色卡',
    description: '从角色图谱纯文本中提取结构化角色卡数据，用于架构生成后自动创建角色卡 JSON 文件',
    systemRole: '你是一位专业的小说数据结构化专家。',
    variables: {
      character_dynamics: '角色图谱纯文本',
      genre: '小说类型',
    },
    content: `请从以下角色图谱文本中提取所有重要角色的结构化信息。

【角色图谱文本】
{{character_dynamics}}

【小说类型】
{{genre}}

【任务要求】
1. 提取所有明确具名且有剧情作用的主要角色、关键配角和次要角色，不要遗漏；无名路人、背景群体或仅提及且无作用者不独立建档。
2. tier 与 role 独立：1=主要角色（持续影响主线且有长期人物线），2=关键配角（影响阶段事件或支线走向），3=次要角色（局部作用）。反派不自动归为1；按图谱描述判断。notes 记录分级依据、剧情作用与预计参与阶段。
3. 所有字段基于图谱内容提取。如果图谱中未明确描写外貌，请务必根据角色的身份背景与性格推测并补充一段丰满的标志性外貌描写（外貌特征绝对不要留空或写未知）。未能确定的其他次要字段可填写空字符串。
4. role 字段仅限以下取值：protagonist（主角）、antagonist（反派）、supporting（配角）、minor（龙套）。
5. currentState 是角色的初始状态（故事开始时），updatedAtChapter 固定为 0。
6. \`tags\`：角色的短标签数组（如 ["天才少年", "复仇者"]，2-5 个，用于角色列表分级展示）。

【输出格式（JSON 数组）】
[
  {
    "name": "角色名",
    "role": "protagonist",
    "tier": 1,
    "gender": "性别",
    "age": "年龄或年龄段",
    "appearance": "外貌特征",
    "personality": "性格特点",
    "background": "背景故事",
    "abilities": "能力/技能/修为",
    "motivation": "核心动机与渴望",
    "relationships": "与其他角色的关系",
    "arc": "预期的角色弧光/成长轨迹",
    "notes": "其他补充说明",
    "tags": ["标签1", "标签2"],
    "currentState": {
      "location": "初始位置",
      "powerLevel": "初始境界/能力等级",
      "physicalState": "初始身体状态",
      "mentalState": "初始心理状态",
      "keyItems": "初始持有道具",
      "recentEvents": "故事开始前的背景事件",
      "updatedAtChapter": 0
    }
  }
]

如果图谱中没有任何可提取的角色，返回空数组 []。`,
  },
  {
    key: 'extract_planned_characters',
    name: '规划阶段角色建档',
    description: '从已保存的章节蓝图提取具名且有剧情作用的新人物，保留已有角色',
    systemRole: '你是严谨的人物规划档案员，只记录规划明确支持的事实。',
    variables: { character_dynamics: '已有姓名与章节蓝图 JSON', genre: '小说类型' },
    content: `小说类型：{{genre}}
规划数据：{{character_dynamics}}
只提取 blueprints.characters 中实际承担 keyEvents 或 purpose 所述行动的新人物。排除 existingNames 中的人物及其别名、无名路人、群体、泛称和仅被提及者。不得另起姓名或编造外貌、能力、背景；未给出的字段留空。
身份 role 为 protagonist/antagonist/supporting/minor；等级 tier 独立判断：1=长期影响主线并有持续人物线，2=决定阶段事件或支线走向，3=局部作用。新出现不等于主要角色；证据不足时为3。
notes 必须写出具体剧情作用、分级依据和计划参与的章节/阶段。不要生成 currentState 或实际出场统计，未来规划不是已发生事实。
仅返回 JSON 数组，每项字段为 name、role、tier、appearance、personality、background、abilities、motivation、relationships、arc、notes、tags。没有新人物返回 []。`,
  },
  {
    key: 'extract_from_finalized',
    name: '从定稿正文提取角色档案',
    description: '基于已定稿章节中该角色出现的相关段落,提取/补全角色静态档案(仅填充空白,不覆盖已有)',
    systemRole: '你是一位严谨的小说角色档案专家,擅长从正文细节还原角色设定。',
    variables: {
      character_name: '角色名',
      chapters_segments: '该角色出现的章节相关段落(带章节号)',
    },
    content: `请从以下已定稿章节的正文片段中,提取角色 {{character_name}} 的静态档案信息。

【角色名】{{character_name}}
【相关正文片段(按章节排列)】
{{chapters_segments}}

【任务要求】
1. 所有档案字段必须基于片段中的明确描写;可以合理推断,但不得编造与原文矛盾的信息。
2. 外貌(appearance):基于出场描写充实一段标志性外貌描写(绝对不要留空)。
3. 片段中未出现的字段输出空字符串(不要写"无"或"未知"——空值不会覆盖已有档案)。
4. tags:角色的短标签数组(2-5 个)。
5. relationships:与片段中其他角色的关系简述。

【输出格式(JSON 对象)】
{
  "gender": "性别",
  "age": "年龄/年龄段",
  "appearance": "标志性外貌描写",
  "personality": "性格特点",
  "background": "背景来历",
  "abilities": "能力/修为",
  "motivation": "核心动机",
  "relationships": "与其他角色的关系",
  "arc": "成长弧线/当前阶段",
  "notes": "补充备注",
  "tags": ["标签1", "标签2"]
}`,
  },
  {
    key: 'extract_from_finalized_batch',
    name: '批量提取角色档案',
    description: '从定稿正文批量提取多个角色的静态档案（一次 LLM 调用处理多角色，按角色分节输入，仅填充空白）',
    systemRole: '你是一位严谨的小说角色档案专家,擅长从正文细节还原角色设定。',
    variables: {
      characters_segments: '多角色及其相关章节段落(带章节号)',
    },
    content: `请从以下已定稿章节的正文片段中,批量提取多个角色的静态档案信息。

【角色与相关片段(每个角色一节,片段按章节排列)】
{{characters_segments}}

【任务要求】
1. 每个角色的所有档案字段必须严格基于该角色对应片段中的明确描写;可以合理推断,但不得编造与原文矛盾的信息。
2. 外貌(appearance):基于出场描写充实一段标志性外貌描写(绝对不要留空)。
3. 片段中未出现的字段输出空字符串(不要写"无"或"未知"——空值不会覆盖已有档案)。
4. tags:角色的短标签数组(2-5 个)。
5. 每个角色都必须输出,不要遗漏;片段中完全没有该角色戏份时,该角色的档案对象可省略。
6. 输出 JSON 对象,键为角色名,值为该角色的档案对象。

【输出格式(JSON 对象)】
{
  "角色名1": {
    "gender": "性别",
    "age": "年龄/年龄段",
    "appearance": "标志性外貌描写",
    "personality": "性格特点",
    "background": "背景来历",
    "abilities": "能力/修为",
    "motivation": "核心动机",
    "relationships": "与其他角色的关系",
    "arc": "成长弧线/当前阶段",
    "notes": "补充备注",
    "tags": ["标签1", "标签2"]
  },
  "角色名2": { "..." : "..." }
}`,
  },
]
