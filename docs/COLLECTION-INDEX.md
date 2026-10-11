# 集合协议与索引

多维表格、媒体库和文件夹集合共用集合协议。文件保存集合身份、数据集规则和视图；SQLite 仅是可重建的索引投影。

## 文件命名与集合身份

- 独立集合使用 `<名称>.index.yaml`。
- 文件夹集合使用该文件夹根目录下的 `.index.yaml`。一个文件夹只配置一个集合，类型只能是笔记集合或媒体库集合之一。
- 文件夹专用的 `.index.yaml` 始终不在笔记本文件树、访问空间文件树和目录文件列表中展示，也不能通过文件可见性设置显示；点击文件夹时仍会读取它并加载集合。
- 文件夹的 `.index.yaml` 通过 `collection.placement: folder` 标明用途；独立文件通过 `placement: standalone` 标明用途。文件名不决定集合类型，`collection.type` 决定是 `notes` 还是 `media`。
- `.table.yaml`、`.table.yml`、`.lib.yaml`、`.lib.yml` 继续作为旧文件名读取。新建及重命名后的独立集合使用 `.index.yaml`。
- 集合 ID 为创建时生成的 `col_` + 32 位 UUIDv7 十六进制字符串。名称、文件名和相对路径均不构成集合身份。

## 数据结构

外层格式版本和业务载荷版本同步递增。当前写入 schema v2；读取 schema v1 旧集合时先在内存中转换为 v2，单纯打开不改磁盘文件，后续编辑保存时写回 v2。集合层、数据集和视图各自承担独立职责：

导航、引用校验、文件夹类型切换和集合索引直接读取 v2 文档。现有表格与媒体编辑器在入口和保存处使用兼容适配，编辑器的旧字段不进入文件中的 `collection` 元数据。

```yaml
format: flowix.collection
schema_version: 2
collection:
  id: col_01900000000070008000000000000000
  type: notes                 # notes | media
  placement: folder           # standalone | folder
  name: 开发任务管理
  revision: 0
  created_at: "2026-10-11T00:00:00.000Z"
  updated_at: "2026-10-11T00:00:00.000Z"
  properties: {}
payload:
  schema_version: 2
  dataset:
    source:
      scope: containing_folder # containing_folder | notebook | folder
      depth: descendants      # direct_children | descendants
    schema:
      primary_field_id: fld_01900000000070008000000000000001
      fields:
        - id: fld_01900000000070008000000000000001
          type: primary
          property_key: note
        - id: fld_01900000000070008000000000000002
          type: Text
          property_key: status
          name: 状态
    records:
      include: []
      exclude: []
    filter:
      all:
        - { field: kind, op: eq, value: note }
      any: []
  views:
    default_id: view_01900000000070008000000000000001
    items:
      - id: view_01900000000070008000000000000001
        name: 表格
        layout: table
        filter: { all: [], any: [] }
        sort:
          - { field: modified_at, direction: desc }
        config:
          visible_fields:
            - fld_01900000000070008000000000000001
            - fld_01900000000070008000000000000002
```

`dataset.source` 限定取数位置和目录深度。文件夹集合必须使用 `containing_folder`，默认使用 `descendants` 包含下层子目录；路径由 `.index.yaml` 的实际父目录解析，不在文件内重复保存路径。独立集合可以使用整个笔记本范围，或用相对笔记本路径指定目录范围。

`dataset.schema` 描述笔记属性字段；笔记属性值仍保存在各笔记 frontmatter。`records.include` 和 `records.exclude` 保存显式记录引用；笔记记录使用 `note_path`，媒体记录使用 `resource_id` 和 `relative_path`。尚未关联笔记的表格草稿行允许 `include.note_path: ""`。`dataset.filter` 保存规则取数条件。媒体集合当前不开放自定义字段，`schema.fields` 应为空；图片和视频身份仍由 `media_resources` 管理。

`dataset.filter: null` 表示不按规则自动收集，仅展示显式记录。启用规则取数后，`{ all: [], any: [] }` 表示对来源范围不增加条件。媒体筛选面板修改 `dataset.filter`；`views.items[].filter` 仅用于视图级筛选，不再重复执行旧版 `file_condition`。

筛选器使用 `all`（全部满足）与 `any`（至少满足一项）；规则项允许再包含一层 `all`/`any` 分组。旧表格中“多个属性同时满足，或命中文件条件”转换为 `any: [{ all: [属性规则…], any: [] }, 文件规则…]`，保留原有匹配结果。

`views.default_id` 指向首次展示的视图。`views.items` 按集合类型保存布局、视图级筛选、排序和布局配置。点击文件夹时读取其 `.index.yaml`，用集合的默认视图打开；首次打开且尚未配置时，显示加载提示，在文件夹根目录创建笔记集合的 `.index.yaml`，随后打开多维表格视图。

## 媒体库数据集示例

```yaml
collection:
  type: media
  placement: folder
payload:
  schema_version: 2
  dataset:
    source: { scope: containing_folder, depth: descendants }
    schema: { fields: [] }
    records:
      include:
        - id: rec_01900000000070008000000000000002
          updated_at: "2026-10-11T00:00:00.000Z"
          resource_id: media_01900000000070008000000000000003
          relative_path: 图片/参考.png
      exclude: []
    filter:
      all:
        - { field: kind, op: in, value: [image, video] }
      any: []
  views:
    default_id: view_01900000000070008000000000000004
    items:
      - id: view_01900000000070008000000000000004
        name: 瀑布流
        layout: waterfall
        filter: { all: [], any: [] }
        sort: [{ field: created_at, direction: desc }]
        config: {}
```

上例展示的是完整 `payload` 的 `dataset` 与 `views` 内容；实际文件仍包含外层 `format`、`schema_version` 和完整 `collection` 元数据。

## 索引与变更

索引存放在 `<notebook>/.flowix/notebook.db`：

| 表 | 用途 |
| --- | --- |
| `collection_documents` | 按相对路径记录集合 ID、类型、名称、版本、revision、属性、时间、指纹和解析状态 |
| `collection_state` | 按集合 ID 保存本地展示偏好 |
| `collection_catalog_meta` | 索引结构版本与事件序号 |
| `collection_operations` | 保存改名、移动、属性修改的恢复日志 |

文件是集合元数据和业务内容的权威来源，索引可重建。索引从 `.index.yaml` 文件内容读取集合类型，因此相同后缀支持笔记和媒体两种独立集合；目录专用 `.index.yaml` 不作为独立集合入口显示。

集合 ID 索引不设唯一约束，以便显示复制产生的冲突。冲突集合禁止按 ID 操作；选定副本可生成新 ID，原集合、记录和视图 ID 保持不变。未知版本可进入索引，但不能编辑；无效文件保留诊断。

集合改名和移动通过 `notebookId + collectionId + expectedRevision + operationId` 定位最新内容并校验 revision。文件夹集合的路径固定为文件夹内的 `.index.yaml`，不允许单独改名或移出文件夹；移动文件夹时集合跟随文件夹移动。独立集合改名保留 `.index.yaml` 后缀。完成写入后刷新索引并发布集合变更事件。

## 展示身份与读取入口

`collectionId` 标识集合；`viewId` 标识集合内部视图；`displayId` 标识工作区中的展示身份。历史记录和展示描述按 ID 恢复，文件路径只作缓存提示。缺少集合、身份冲突、视图缺失或版本不支持时显示不可用状态。

桌面端统一使用 `list_collections`、`resolve_collection`、`mutate_collection`、`set_collection_display_state` 和 `make_collection_identity_unique`。CLI 与 MCP 共用只读操作 `collection.read`，可按集合 ID 或笔记本内相对路径读取。读取返回原始 payload，不运行视图筛选、分页或笔记 frontmatter 展开。

- 公共协议：`app/flowix-core/src/collection.rs`、`app/flowix-web/features/collection/model.ts`
- 索引和生命周期：`app/flowix-desktop/src/commands/collection.rs`
- 文件夹点击与导航：`app/flowix-web/features/memo/components/notebook-folder-view.tsx`、`app/flowix-web/features/workspace/use-cases/workspace-navigation.ts`
- 展示注册表：`app/flowix-web/lib/collection-display-registry.ts`
