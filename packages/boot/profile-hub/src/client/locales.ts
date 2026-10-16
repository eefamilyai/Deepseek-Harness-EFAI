/** Profiles-surface copy: the landing page, its rows, and its outcomes. */

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Profiles-surface copy: the profile list, its actions, and its create form. */
    profileHub: ProfileHubKey
  }
}

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'profileHub.open': '配置文件',
  'profileHub.title': '配置文件',
  'profileHub.panel': '配置文件',
  'profileHub.description': '每个配置文件都是一套独立的 harness：自己的会话、自己的工作目录、自己的 DeepSeek 账号。',
  'profileHub.close': '关闭',
  'profileHub.loadError': '无法读取配置文件列表。',
  'profileHub.missing': '此进程中没有配置文件服务。',
  'profileHub.empty': '这台机器上还没有任何配置文件。',
  'profileHub.section.yours': '你的配置文件',
  'profileHub.section.reserved': '系统保留',
  'profileHub.badge.current': '当前',
  'profileHub.badge.launcher': '启动页',
  'profileHub.badge.running': '运行中',
  'profileHub.badge.reserved': '保留',
  'profileHub.meta.chats': '{count} 个会话',
  'profileHub.meta.shared': '共用会话列表',
  'profileHub.meta.bundles': '{count} 个组合包',
  'profileHub.open.app': '在应用中打开',
  'profileHub.open.browser': '浏览器',
  'profileHub.open.app.busy': '正在打开…',
  'profileHub.open.browser.busy': '正在启动…',
  'profileHub.open.app.done': '已在桌面端打开「{name}」。',
  'profileHub.open.app.unavailable': '只有在桌面版中运行时才能打开桌面窗口。',
  'profileHub.open.app.current': '这个窗口已经运行该配置文件。',
  'profileHub.more': '更多操作',
  'profileHub.stop': '停止',
  'profileHub.launchOnStartup': '设为启动页',
  'profileHub.delete': '删除',
  'profileHub.delete.confirm': '删除「{name}」及其全部会话？',
  'profileHub.keep': '保留',
  'profileHub.new.toggle': '新建配置文件',
  'profileHub.new.name': '名称',
  'profileHub.new.namePlaceholder': 'school',
  'profileHub.new.label': '标题',
  'profileHub.new.labelPlaceholder': '学校',
  'profileHub.new.workdir': '工作目录',
  'profileHub.new.workdirPlaceholder': 'C:\\Users\\me\\School',
  'profileHub.new.clone': '沿用当前配置文件的设置',
  'profileHub.new.create': '创建',
  'profileHub.new.creating': '正在创建…',
} satisfies Record<string, string>

/** The section's key union: the zh dictionary's key set. */
export type ProfileHubKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'profileHub.open': 'Profiles',
  'profileHub.title': 'Profiles',
  'profileHub.panel': 'Profiles',
  'profileHub.description': 'Each profile is its own harness: its own chats, its own working folder, its own DeepSeek account.',
  'profileHub.close': 'Close',
  'profileHub.loadError': 'Could not read the profile list.',
  'profileHub.missing': 'This host has no profile service.',
  'profileHub.empty': 'No profiles on this machine yet.',
  'profileHub.section.yours': 'Your profiles',
  'profileHub.section.reserved': 'Reserved',
  'profileHub.badge.current': 'Current',
  'profileHub.badge.launcher': 'Opens first',
  'profileHub.badge.running': 'Running',
  'profileHub.badge.reserved': 'Reserved',
  'profileHub.meta.chats': '{count} chats',
  'profileHub.meta.shared': 'Shares the home chat list',
  'profileHub.meta.bundles': '{count} bundles',
  'profileHub.open.app': 'Open in app',
  'profileHub.open.browser': 'Browser',
  'profileHub.open.app.busy': 'Opening\u2026',
  'profileHub.open.browser.busy': 'Starting\u2026',
  'profileHub.open.app.done': 'Opened "{name}" in the Desktop app.',
  'profileHub.open.app.unavailable': 'A Desktop window needs the Desktop app to be running this page.',
  'profileHub.open.app.current': 'This window already runs this profile.',
  'profileHub.more': 'More actions',
  'profileHub.stop': 'Stop',
  'profileHub.launchOnStartup': 'Open on startup',
  'profileHub.delete': 'Delete',
  'profileHub.delete.confirm': 'Delete "{name}" and every chat it holds?',
  'profileHub.keep': 'Keep',
  'profileHub.new.toggle': 'New profile',
  'profileHub.new.name': 'Name',
  'profileHub.new.namePlaceholder': 'school',
  'profileHub.new.label': 'Title',
  'profileHub.new.labelPlaceholder': 'School',
  'profileHub.new.workdir': 'Working folder',
  'profileHub.new.workdirPlaceholder': 'C:\\Users\\me\\School',
  'profileHub.new.clone': "Start from this profile's settings",
  'profileHub.new.create': 'Create',
  'profileHub.new.creating': 'Creating\u2026',
} satisfies Record<ProfileHubKey, string>
