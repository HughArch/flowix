// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  notesList,
  readExternalDocument,
  listTableDocuments,
  getFeaturedNoteFilter,
  setFeaturedNoteFilter,
  toastError,
} = vi.hoisted(() => ({
  notesList: vi.fn(),
  readExternalDocument: vi.fn(),
  listTableDocuments: vi.fn(),
  getFeaturedNoteFilter: vi.fn(),
  setFeaturedNoteFilter: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock("@platform/tauri/client", () => ({
  agent: {},
  dshIntegration: { checkUpdate: vi.fn() },
  files: { listTableDocuments },
  // 精选笔记的数据源是选中的多维表格文档, 按笔记本相对路径读取。
  externalDocuments: { read: readExternalDocument },
  notes: { list: notesList },
  windows: {},
  // 筛选配置与表格选择都存在笔记本文件夹的 `.flownote/system.json`, 走 system IPC。
  system: { getFeaturedNoteFilter, setFeaturedNoteFilter },
}));

vi.mock("@platform/tauri/event-bus", () => ({
  subscribe: vi.fn(() => vi.fn()),
}));

vi.mock("@/lib/toast", () => ({
  toast: { error: toastError, info: vi.fn(), success: vi.fn(), warning: vi.fn() },
}));

vi.mock("@features/memo/store/note-store", () => ({
  useNoteStore: {
    getState: () => ({
      selectedNotebook: { id: "notebook-1", path: "/books/nb1" },
      notebooks: [{ id: "notebook-1", path: "/books/nb1", missing: false }],
    }),
  },
}));

vi.mock("@features/memo/public/note-navigation-api", () => ({
  openNoteByMemoId: vi.fn(),
  openNoteByNotebookPath: vi.fn(),
}));

import { ExternalAgentSettingsController } from "./external-agent-settings-controller";

/** 两张可供选择的表格文档 (相对路径 + collection id)。 */
const SKILLS_TABLE = {
  name: "skills",
  relativePath: "tables/skills.table.yaml",
  collectionId: "col_11111111111111111111111111111111",
} as const;
const PROJECTS_TABLE = {
  name: "projects",
  relativePath: "tables/projects.table.yaml",
  collectionId: "col_22222222222222222222222222222222",
} as const;

/** 笔记索引里的一条记录 (notes.list 返回形状的最小子集)。 */
function indexedNote(id: string, properties: Record<string, unknown> = {}) {
  return {
    relativePath: `${id}.md`,
    title: id,
    preview: `${id} description`,
    icon: null as string | null,
    properties,
  };
}

/**
 * 生成一份能通过 parseTableDocument 校验的最小多维表格 YAML。
 * records.include 的契约只允许 id / updated_at / note_path 三个键。
 */
function tableDocumentYaml(collectionId: string, notePaths: string[]): string {
  const records = notePaths.map((notePath, index) => {
    const id = `rec_${String(index + 1).padStart(2, "0")}${"1".repeat(30)}`;
    return `        - { id: ${id}, updated_at: "2026-10-11T00:00:00Z", note_path: ${notePath} }`;
  }).join("\n");
  return `format: flownote.collection
schema_version: 2
collection:
  id: ${collectionId}
  type: notes
  placement: folder
  revision: 1
  created_at: 2026-10-11T00:00:00Z
  updated_at: 2026-10-11T00:00:00Z
  properties: {}
payload:
  schema_version: 2
  dataset:
    source: { scope: containing_folder, depth: descendants }
    schema:
      field_order:
        - fld_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      primary_field_id: fld_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
      fields:
        - { id: fld_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa, type: primary, property_key: note }
    filter: null
    records:
      include:
${records}
      exclude: []
  views:
    default_id: view_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    items:
      - id: view_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
        name: 表格
        layout: table
        filter: { all: [], any: [] }
        sort: []
        config:
          visible_fields:
            - fld_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
`;
}

/** 模拟笔记本文件夹里 `.flownote/system.json` 的 featuredNotes 段。 */
let storedSystemConfig: {
  conditions: Array<{ key: string; operator: string; value: string }>;
  tableSelection: { relativePath: string; tableId: string } | null;
};

const DEFAULT_CONDITION = { key: "type", operator: "equals", value: "skill" };

describe("ExternalAgentSettingsController featured notes", () => {
  beforeEach(() => {
    document.body.replaceChildren();
    // 默认已选中 skills 表 ── 卡片内容来自该表格的 records。
    storedSystemConfig = {
      conditions: [{ ...DEFAULT_CONDITION }],
      tableSelection: { relativePath: SKILLS_TABLE.relativePath, tableId: SKILLS_TABLE.collectionId },
    };
    // 深拷贝返回: 生产代码会就地读 tableSelection / conditions, 不能让 mock 与
    // 被测代码共享同一份可变对象。
    getFeaturedNoteFilter.mockReset();
    getFeaturedNoteFilter.mockImplementation(async () => JSON.parse(JSON.stringify(storedSystemConfig)));
    setFeaturedNoteFilter.mockReset();
    setFeaturedNoteFilter.mockImplementation(async (_notebookId: string, config: typeof storedSystemConfig) => {
      storedSystemConfig = JSON.parse(JSON.stringify(config));
    });
    notesList.mockReset();
    notesList.mockResolvedValue([indexedNote("skill"), indexedNote("pinned")]);
    listTableDocuments.mockReset();
    listTableDocuments.mockResolvedValue([
      { name: SKILLS_TABLE.name, relativePath: SKILLS_TABLE.relativePath, collectionId: SKILLS_TABLE.collectionId },
      { name: PROJECTS_TABLE.name, relativePath: PROJECTS_TABLE.relativePath, collectionId: PROJECTS_TABLE.collectionId },
    ]);
    readExternalDocument.mockReset();
    readExternalDocument.mockImplementation(async (filePath: string) => (
      filePath.includes(PROJECTS_TABLE.relativePath)
        ? tableDocumentYaml(PROJECTS_TABLE.collectionId, ["pinned.md"])
        : tableDocumentYaml(SKILLS_TABLE.collectionId, ["skill.md"])
    ));
    toastError.mockReset();
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      value: vi.fn(() => ({
        matches: false,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * 表格选择弹层被 append 到 document.body (与 composer 的模型/权限弹窗同款),
   * 因此不能再用 empty.querySelector 去找, 必须从 body 上取。
   */
  function findPicker(): HTMLElement | null {
    return document.body.querySelector(".agent-thread-card__featured-notes-view-picker");
  }

  function createController(extra: Partial<ConstructorParameters<typeof ExternalAgentSettingsController>[0]> = {}) {
    return new ExternalAgentSettingsController({
      popover: document.createElement("div"),
      getTypeKey: () => "codex",
      getInstanceId: () => undefined,
      getLanguage: () => "zh-CN",
      t: (key) => key,
      isDestroyed: () => false,
      ...extra,
    });
  }

  async function openPicker(empty: HTMLElement): Promise<HTMLElement> {
    empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    )?.click();
    await vi.waitFor(() => {
      expect(findPicker()?.hidden).toBe(false);
      expect(findPicker()?.querySelector(".agent-thread-card__featured-notes-view-option"))
        .not.toBeNull();
    });
    return findPicker()!;
  }

  it("keeps the Agent icon and settings before asynchronously loaded note cards", async () => {
    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes")).not.toBeNull();
    });
    // 卡片内容来自选中表格 → 需要读笔记索引建立 note_path 映射。
    expect(notesList).toHaveBeenCalledWith("notebook-1");

    const children = Array.from(empty.children);
    const iconIndex = children.findIndex((node) => node.classList.contains("agent-thread-card__empty-agent-icon"));
    const controlsIndex = children.findIndex((node) => node.classList.contains("agent-conversation__controls"));
    const notesIndex = children.findIndex((node) => node.classList.contains("agent-thread-card__featured-notes"));
    expect(iconIndex).toBeGreaterThanOrEqual(0);
    expect(controlsIndex).toBeGreaterThan(iconIndex);
    expect(notesIndex).toBeGreaterThan(controlsIndex);
    const notesPanel = empty.querySelector(".agent-thread-card__featured-notes");
    const panelChildren = Array.from(notesPanel?.children ?? []);
    expect(panelChildren.findIndex((node) => node.classList.contains("agent-thread-card__featured-notes-settings-footer")))
      .toBeGreaterThan(panelChildren.findIndex((node) => node.classList.contains("agent-thread-card__featured-notes-list")));
    const settingsFooter = notesPanel?.querySelector(".agent-thread-card__featured-notes-settings-footer");
    expect(settingsFooter?.querySelector(".agent-thread-card__featured-notes-settings-button")).not.toBeNull();
    expect(settingsFooter?.querySelector(".agent-thread-card__featured-notes-navigation")).not.toBeNull();

    controller.dispose();
  });

  it("persists a table selection and refreshes the visible cards", async () => {
    // 旧模型按 key/operator/value 条件过滤笔记; ec591686 起卡片内容改由选中的
    // 多维表格决定, 设置弹层是"选表格"。等价覆盖: 换选表格 → 落盘选择 → 卡片刷新。
    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-note-title")?.textContent)
        .toBe("skill");
    });

    const picker = await openPicker(empty);
    const projectsOption = Array.from(
      picker.querySelectorAll<HTMLButtonElement>(".agent-thread-card__featured-notes-view-option"),
    ).find((option) => option.textContent?.includes("projects"));
    expect(projectsOption).toBeDefined();
    projectsOption!.click();

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-note-title")?.textContent)
        .toBe("pinned");
    });
    // 落盘到笔记本文件夹的 .flownote/system.json: 保留已存条件 + 新表格选择。
    expect(setFeaturedNoteFilter).toHaveBeenCalledWith("notebook-1", {
      conditions: [{ ...DEFAULT_CONDITION }],
      tableSelection: { relativePath: PROJECTS_TABLE.relativePath, tableId: PROJECTS_TABLE.collectionId },
    });

    controller.dispose();
  });

  it("surfaces a persist failure and keeps the picker usable", async () => {
    // 落盘失败必须可见且可重试: 静默失败会让用户以为配置已生效。
    setFeaturedNoteFilter.mockRejectedValue(new Error("unsupported operator"));

    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const picker = await openPicker(empty);
    const option = picker.querySelector<HTMLButtonElement>(".agent-thread-card__featured-notes-view-option")!;
    option.click();

    await vi.waitFor(() => {
      expect(toastError).toHaveBeenCalledWith("editor.threadCard.featuredNotes.saveFailed");
    });
    // 选项按钮恢复可用, 弹层保持打开, 用户可以重试或换一张表。
    expect(option.disabled).toBe(false);
    expect(findPicker()?.hidden).toBe(false);

    controller.dispose();
  });

  it("positions the root-level picker with viewport coordinates and flips it above", async () => {
    // 弹层挂到 document.body 后用 fixed + 视口坐标定位 (与 composer 的模型/权限
    // 弹窗同款)。这里断言真实的 top/left 计算值: 当按钮下方放不下时, 弹层应翻到
    // 按钮上方, 而不是溢出到视口外或被裁剪。
    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const settingsButton = empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    );
    // 按钮贴近视口底部 (jsdom 默认高 768): 下方只剩 20px, 放不下 220px 弹层,
    // 且按钮上方空间充足, 因此应向上翻转。
    vi.spyOn(settingsButton as HTMLButtonElement, "getBoundingClientRect").mockReturnValue({
      top: 748, bottom: 768, left: 380, right: 420,
      width: 40, height: 20, x: 380, y: 748, toJSON: () => ({}),
    } as DOMRect);

    // 弹层元素此时已挂在 body 上 (创建即 append), 先设好尺寸再打开。
    const picker = findPicker();
    vi.spyOn(picker as HTMLElement, "getBoundingClientRect").mockReturnValue({
      top: 0, bottom: 0, left: 0, right: 0,
      width: 420, height: 220, x: 0, y: 0, toJSON: () => ({}),
    } as DOMRect);

    settingsButton?.click();

    // placeAbove → top = anchorTop - offset(6) - height(220) = 748 - 6 - 220 = 522
    expect(picker?.style.top).toBe("522px");
    // left 夹在 [padding(8), viewportWidth - padding - width] 之间
    expect(picker?.style.left).toBe("380px");

    controller.dispose();
  });

  it("renders the picker as heading, options list and create action, in order", async () => {
    // 锁住选择弹层依赖的 DOM 契约: 标题 → 列表 (listbox + 选项) → 建表动作。
    // 旧的条件行表单已不存在, 这是它在新模型下的等价结构断言。
    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const picker = await openPicker(empty);
    expect(Array.from(picker.children).map((node) => node.className)).toEqual([
      "agent-thread-card__featured-notes-view-heading",
      "agent-thread-card__featured-notes-view-list",
      "agent-thread-card__featured-notes-view-create-row",
    ]);
    expect(picker.querySelector(".agent-thread-card__featured-notes-view-heading")?.textContent)
      .toBe("editor.threadCard.featuredNotes.settingsTitle");

    const items = picker.querySelector(".agent-thread-card__featured-notes-view-items");
    expect(items?.getAttribute("role")).toBe("listbox");
    // 加载完成后的状态行要移除, 只剩表格选项。
    expect(picker.querySelector(".agent-thread-card__featured-notes-view-status")).toBeNull();
    const options = Array.from(items?.children ?? []);
    expect(options).toHaveLength(2);
    for (const option of options) {
      expect(option.classList.contains("agent-thread-card__featured-notes-view-option")).toBe(true);
      // 选项 = 图标 + 标签; 表名只来自 title span (无独立标签文本)。
      expect(option.querySelector(".agent-thread-card__featured-notes-view-option-icon")).not.toBeNull();
      expect(option.querySelector(".agent-thread-card__featured-notes-view-option-label")?.textContent)
        .toMatch(/^(skills|projects)$/);
    }

    controller.dispose();
  });

  it("shows a no-tables status when the notebook has no tables", async () => {
    // 空笔记本时弹层要有明确的空态提示, 而不是永远停在加载文案。
    listTableDocuments.mockResolvedValue([]);

    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    )?.click();
    await vi.waitFor(() => {
      expect(findPicker()?.querySelector(".agent-thread-card__featured-notes-view-status")?.textContent)
        .toBe("editor.threadCard.featuredNotes.noTables");
    });
    expect(findPicker()?.querySelectorAll(".agent-thread-card__featured-notes-view-option")).toHaveLength(0);

    controller.dispose();
  });

  it("exposes the picker as a labelled dialog that starts hidden", async () => {
    // 无障碍契约: 弹层是带标题的 dialog, 挂在 body 且初始隐藏; 打开后触发按钮
    // 的 aria-expanded 同步翻转。
    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const settingsButton = empty.querySelector<HTMLButtonElement>(
      ".agent-thread-card__featured-notes-settings-button",
    );
    const picker = findPicker();
    expect(picker?.getAttribute("role")).toBe("dialog");
    expect(picker?.getAttribute("aria-label")).toBe("editor.threadCard.featuredNotes.settingsTitle");
    expect(picker?.hidden).toBe(true);
    expect(settingsButton?.getAttribute("aria-expanded")).toBe("false");

    settingsButton?.click();
    expect(picker?.hidden).toBe(false);
    expect(settingsButton?.getAttribute("aria-expanded")).toBe("true");
    // 标题必须是弹层第一个子节点, 列表紧随其后 (旧"标题在表单之前"的迁移)。
    const first = picker?.firstElementChild as HTMLElement | null;
    expect(first?.className).toBe("agent-thread-card__featured-notes-view-heading");
    expect(first?.nextElementSibling?.className).toBe("agent-thread-card__featured-notes-view-list");

    controller.dispose();
  });

  it("lists exactly the notebook's tables and marks the current selection", async () => {
    // 旧测试断言条件下拉只提供 equals/contains; 新模型里弹层列出的是笔记本的
    // 表格清单, 并用 aria-selected 标出当前选中的表。
    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const picker = await openPicker(empty);
    const options = Array.from(
      picker.querySelectorAll<HTMLButtonElement>(".agent-thread-card__featured-notes-view-option"),
    );
    expect(options.map((option) => option.textContent)).toEqual(["skills", "projects"]);
    expect(options.map((option) => option.getAttribute("aria-selected"))).toEqual(["true", "false"]);

    controller.dispose();
  });

  it("renders an empty panel without touching the note index when no table is selected", async () => {
    // 迁移说明: 旧"legacy operator 归一化"测试覆盖的过滤 UI 已被表格选择替代
    // (条件归一化现在只服务于提示词组装, 不再经过这个控制器)。等价覆盖新模型
    // 的关键早退分支: 未选表时不读笔记索引、不读表格文档, 但设置入口仍可用。
    storedSystemConfig = { conditions: [{ ...DEFAULT_CONDITION }], tableSelection: null };

    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes")).not.toBeNull();
    });
    expect(notesList).not.toHaveBeenCalled();
    expect(readExternalDocument).not.toHaveBeenCalled();
    expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button")).not.toBeNull();
    expect(
      empty.querySelector<HTMLElement>(".agent-thread-card__featured-notes-list")?.dataset.cardCount,
    ).toBe("0");

    controller.dispose();
  });

  it("create-table action dispatches the dialog request and reports when unhandled", async () => {
    // 「新建表格」通过全局 CustomEvent 交给宿主窗口处理; 没有宿主接单时必须
    // 给用户一个可见的失败提示, 而不是点了没反应。
    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    await openPicker(empty);
    const handler = vi.fn();
    window.addEventListener("flownote:open-create-table-dialog", handler);
    try {
      findPicker()?.querySelector<HTMLButtonElement>(".agent-thread-card__featured-notes-view-create")?.click();
      await vi.waitFor(() => expect(handler).toHaveBeenCalledTimes(1));
      const event = handler.mock.calls[0][0] as CustomEvent;
      expect(event.detail.notebookId).toBe("notebook-1");
      expect(typeof event.detail.onCreated).toBe("function");
      // 无人 preventDefault → 提示无法打开创建窗口。
      expect(toastError).toHaveBeenCalledWith("无法打开多维表格创建窗口");
    } finally {
      window.removeEventListener("flownote:open-create-table-dialog", handler);
    }

    controller.dispose();
  });

  it("paginates cards three per page with working navigation", async () => {
    // 每页固定 3 张 (FEATURED_NOTE_PAGE_SIZE); 旧"条件行增删"测试的位置由
    // 分页交互覆盖 ── 这是设置 footer 里导航按钮的实际职责。
    notesList.mockResolvedValue([
      indexedNote("skill"), indexedNote("alpha"), indexedNote("beta"), indexedNote("gamma"),
    ]);
    readExternalDocument.mockImplementation(async (filePath: string) => (
      filePath.includes(PROJECTS_TABLE.relativePath)
        ? tableDocumentYaml(PROJECTS_TABLE.collectionId, ["pinned.md"])
        : tableDocumentYaml(SKILLS_TABLE.collectionId, ["skill.md", "alpha.md", "beta.md", "gamma.md"])
    ));

    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelectorAll("button.agent-thread-card__featured-note")).toHaveLength(3);
    });
    const notesPanel = empty.querySelector(".agent-thread-card__featured-notes")!;
    const nextButton = notesPanel.querySelector<HTMLButtonElement>(".agent-thread-card__featured-notes-nav[aria-label='editor.threadCard.featuredNotes.next']")!;
    const prevButton = notesPanel.querySelector<HTMLButtonElement>(".agent-thread-card__featured-notes-nav[aria-label='editor.threadCard.featuredNotes.previous']")!;
    // 第一页: 上一页禁用, 下一页可用。
    expect(prevButton.disabled).toBe(true);
    expect(nextButton.disabled).toBe(false);
    expect(nextButton.hidden).toBe(false);

    nextButton.click();
    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-note-title")?.textContent).toBe("gamma");
    });
    expect(empty.querySelectorAll("button.agent-thread-card__featured-note")).toHaveLength(1);
    expect(prevButton.disabled).toBe(false);
    expect(nextButton.disabled).toBe(true);

    prevButton.click();
    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-note-title")?.textContent).toBe("skill");
    });

    controller.dispose();
  });

  it("switching tables preserves the stored conditions", async () => {
    // 表格选择写入时不能覆盖用户已保存的筛选条件 ── system.json 里两段配置
    // 共用一个文件, 写入方负责原样带回 conditions。
    storedSystemConfig = {
      conditions: [{ key: "pin", operator: "equals", value: "true" }],
      tableSelection: { relativePath: SKILLS_TABLE.relativePath, tableId: SKILLS_TABLE.collectionId },
    };

    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector(".agent-thread-card__featured-notes-settings-button"))
        .not.toBeNull();
    });

    const picker = await openPicker(empty);
    const projectsOption = Array.from(
      picker.querySelectorAll<HTMLButtonElement>(".agent-thread-card__featured-notes-view-option"),
    ).find((option) => option.textContent?.includes("projects"))!;
    projectsOption.click();

    await vi.waitFor(() => {
      expect(setFeaturedNoteFilter).toHaveBeenCalled();
    });
    expect(setFeaturedNoteFilter).toHaveBeenCalledWith("notebook-1", {
      conditions: [{ key: "pin", operator: "equals", value: "true" }],
      tableSelection: { relativePath: PROJECTS_TABLE.relativePath, tableId: PROJECTS_TABLE.collectionId },
    });

    controller.dispose();
  });

  it("renders note cards as icon plus content, with no try button", async () => {
    // 卡片首行原先右侧有个「试试」按钮 (featured-note-try), 已移除; 图标现在
    // 是卡片的直接子项, 与内容并列。单页时翻页按钮隐藏。
    const controller = createController();
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector("button.agent-thread-card__featured-note")).not.toBeNull();
    });

    const card = empty.querySelector<HTMLButtonElement>(
      "button.agent-thread-card__featured-note",
    );
    expect(card?.querySelector(".agent-thread-card__featured-note-try")).toBeNull();
    expect(Array.from(card?.children ?? []).map((node) => node.className)).toEqual([
      "agent-thread-card__featured-note-icon",
      "agent-thread-card__featured-note-content",
    ]);
    for (const button of empty.querySelectorAll<HTMLButtonElement>(".agent-thread-card__featured-notes-nav")) {
      expect(button.hidden).toBe(true);
    }

    controller.dispose();
  });

  it("inserts the note into the composer when a card is clicked", async () => {
    // 点击卡片不再打开笔记, 而是把该笔记作为行内引用交给宿主注入输入框。
    const onSelectFeaturedNote = vi.fn();
    const controller = createController({ onSelectFeaturedNote });
    const empty = controller.createEmptySettings();
    document.body.append(empty);

    await vi.waitFor(() => {
      expect(empty.querySelector("button.agent-thread-card__featured-note")).not.toBeNull();
    });

    empty.querySelector<HTMLButtonElement>(
      "button.agent-thread-card__featured-note",
    )?.click();

    expect(onSelectFeaturedNote).toHaveBeenCalledTimes(1);
    // id/relativePath 来自表格记录的 note_path; 标题取自笔记索引去掉 .md。
    expect(onSelectFeaturedNote).toHaveBeenCalledWith({
      id: "skill.md",
      filename: "skill",
      title: "skill",
      notebookId: "notebook-1",
      relativePath: "skill.md",
    });

    controller.dispose();
  });
});
