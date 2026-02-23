import AsyncStorage from "@react-native-async-storage/async-storage";

export interface CustomAction {
  id: string;
  label: string;
  prompt: string;
  icon: string;
  isDefault: boolean;
  order: number;
}

const DEFAULT_ACTIONS: CustomAction[] = [
  { id: "default_commit", label: "Commit", prompt: "请 git add 所有更改并 git commit，帮我写一个合适的 commit message", icon: "✓", isDefault: true, order: 0 },
  { id: "default_push", label: "Push", prompt: "请 git push 到远程仓库", icon: "↑", isDefault: true, order: 1 },
  { id: "default_pull", label: "Pull", prompt: "请 git pull 拉取最新代码", icon: "↓", isDefault: true, order: 2 },
  { id: "default_status", label: "Status", prompt: "请检查 git status 和当前项目状态", icon: "?", isDefault: true, order: 3 },
  { id: "default_test", label: "Test", prompt: "请运行测试（npm test 或对应的测试命令）", icon: "▶", isDefault: true, order: 4 },
  { id: "default_build", label: "Build", prompt: "请运行构建（npm run build 或对应的构建命令）", icon: "⚡", isDefault: true, order: 5 },
  { id: "default_install", label: "Install", prompt: "请运行 npm install 安装依赖", icon: "📦", isDefault: true, order: 6 },
];

const storageKey = (projectId: string) => `pocket-code:quick-actions:${projectId}`;

export async function loadQuickActions(projectId: string): Promise<CustomAction[]> {
  try {
    const raw = await AsyncStorage.getItem(storageKey(projectId));
    if (raw) {
      const actions: CustomAction[] = JSON.parse(raw);
      return actions.sort((a, b) => a.order - b.order);
    }
  } catch { }
  return [...DEFAULT_ACTIONS];
}

export async function saveQuickActions(projectId: string, actions: CustomAction[]): Promise<void> {
  await AsyncStorage.setItem(storageKey(projectId), JSON.stringify(actions));
}

export function createAction(label: string, prompt: string, icon: string, order: number): CustomAction {
  return {
    id: `custom_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    label,
    prompt,
    icon,
    isDefault: false,
    order,
  };
}
