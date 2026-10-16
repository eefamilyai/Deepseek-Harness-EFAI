/** `peakHours` namespace dictionaries: the pricing indicator and its notifications. */

/** Dictionary namespace owned by this plugin. */
export const NS = 'peakHours'

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'pill.peak': 'DeepSeek 高峰 2× · 剩余 {remaining}',
  'pill.soon': 'DeepSeek 高峰 2× · {remaining}后开始',
  'pill.offPeak': 'DeepSeek 低峰 · {remaining}后高峰',
  'pill.offPeakNone': 'DeepSeek 低峰',
  'pill.invalid': '高峰时段配置无效',
  'tip.peak': 'DeepSeek API 正按高峰价计费（低峰价的 2 倍），至 {time} 结束。',
  'tip.soon': 'DeepSeek API 将于 {time} 开始按高峰价计费（低峰价的 2 倍）。',
  'tip.offPeak.hours': 'DeepSeek API 正按低峰价计费。下次高峰：{time}。',
  'tip.offPeak.weekend': '周末：DeepSeek API 全天按低峰价计费。下次高峰：{time}。',
  'tip.offPeak.holiday': '{holiday}（中国法定节假日）：DeepSeek API 全天按低峰价计费。下次高峰：{time}。',
  'tip.noNext': '一个月内没有高峰时段。',
  'tip.windows': '工作日高峰时段（本地时间）：{windows}。周末和中国法定节假日全天为低峰。',
  'tip.invalid': '无法判断高峰时段：{problems}',
  'duration.days': '{days}天{hours}小时',
  'duration.hours': '{hours}小时{minutes}分',
  'duration.minutes': '{minutes}分钟',
  'notify.soon.title': 'DeepSeek 高峰即将开始',
  'notify.soon.body': '{time} 起 DeepSeek API 按 2 倍价格计费。',
  'notify.peak.title': 'DeepSeek 高峰已开始',
  'notify.peak.body': 'DeepSeek API 按 2 倍价格计费，至 {time} 结束。',
  'gate.title': 'DeepSeek 正处于高峰时段',
  'gate.body': '{model} 现在按高峰价计费（低峰价的 2 倍），高峰至 {time} 结束（还有 {remaining}）。',
  'gate.send': '仍然发送',
  'gate.schedule': '定时到 {time} 发送',
  'gate.edit': '继续编辑',
  'gate.close': '继续编辑',
  'gate.pending': '此会话已有消息在等待 {time} 发送：',
  'gate.together': '并入最后一条等待中的消息',
  'gate.togetherHint': '这条消息追加到它的末尾，在 {time} 作为同一条消息发送。',
  'gate.after': '排在等待中的消息之后',
  'gate.afterHint': '{time} 时先发送等待中的消息，它们的回合全部结束后再发送这条。',
  'gate.noAttachments': '带附件的消息无法定时发送。',
  'gate.noSchedule': '无法在此会话中定时发送。',
  'gate.scheduled': '已安排在 {time} 发送。可在“自动化任务”中查看或取消。',
  'gate.merged': '已与 {time} 发送的消息合并。',
  'gate.queued': '已排在 {time} 发送的消息之后。',
  'gate.failed': '未能定时发送：{message}',
} satisfies Record<string, string>

/** The peakHours namespace key union. */
export type PeakHoursKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'pill.peak': 'DeepSeek peak 2× · {remaining} left',
  'pill.soon': 'DeepSeek peak 2× in {remaining}',
  'pill.offPeak': 'DeepSeek off-peak · peak in {remaining}',
  'pill.offPeakNone': 'DeepSeek off-peak',
  'pill.invalid': 'Peak schedule invalid',
  'tip.peak': 'The DeepSeek API is billing peak rates (2× off-peak) until {time}.',
  'tip.soon': 'The DeepSeek API starts billing peak rates (2× off-peak) at {time}.',
  'tip.offPeak.hours': 'The DeepSeek API is billing off-peak rates. Next peak: {time}.',
  'tip.offPeak.weekend': 'Weekend: the DeepSeek API bills off-peak rates all day. Next peak: {time}.',
  'tip.offPeak.holiday': '{holiday} (Chinese public holiday): the DeepSeek API bills off-peak rates all day. Next peak: {time}.',
  'tip.noNext': 'No peak period within the next month.',
  'tip.windows': 'Weekday peak hours in your time: {windows}. Weekends and Chinese public holidays are off-peak all day.',
  'tip.invalid': 'Cannot tell peak hours apart: {problems}',
  'duration.days': '{days}d {hours}h',
  'duration.hours': '{hours}h {minutes}m',
  'duration.minutes': '{minutes}m',
  'notify.soon.title': 'DeepSeek peak pricing soon',
  'notify.soon.body': 'From {time} the DeepSeek API bills 2× rates.',
  'notify.peak.title': 'DeepSeek peak pricing started',
  'notify.peak.body': 'The DeepSeek API bills 2× rates until {time}.',
  'gate.title': 'DeepSeek peak hours',
  'gate.body': '{model} is billing peak rates (2× off-peak) right now. Peak ends at {time} ({remaining} from now).',
  'gate.send': 'Send anyway',
  'gate.schedule': 'Schedule for {time}',
  'gate.edit': 'Keep editing',
  'gate.close': 'Keep editing',
  'gate.pending': 'Already waiting in this session to send at {time}:',
  'gate.together': 'Add to the last waiting message',
  'gate.togetherHint': 'This text is appended to it, and both go out as one message at {time}.',
  'gate.after': 'Queue after the waiting messages',
  'gate.afterHint': 'At {time} the waiting messages go first; this one starts only once their turns have fully settled.',
  'gate.noAttachments': 'A message with attachments cannot be scheduled.',
  'gate.noSchedule': 'This session cannot schedule messages.',
  'gate.scheduled': 'Scheduled for {time}. See or cancel it in Automation tasks.',
  'gate.merged': 'Added to the message sending at {time}.',
  'gate.queued': 'Queued after the message sending at {time}.',
  'gate.failed': 'Could not schedule the message: {message}',
} satisfies Record<PeakHoursKey, string>

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The DeepSeek peak-hour indicator's copy. */
    peakHours: PeakHoursKey
  }
}
