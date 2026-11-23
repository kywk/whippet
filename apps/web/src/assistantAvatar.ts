import bourbon from './assets/assistant-avatars/bourbon.webp?no-inline';
import fleetfoot from './assets/assistant-avatars/fleetfoot.webp?no-inline';
import slingshot from './assets/assistant-avatars/slingshot.webp?no-inline';
import sounders from './assets/assistant-avatars/sounders.webp?no-inline';
import zorro from './assets/assistant-avatars/zorro.webp?no-inline';

export interface AssistantAvatar {
  readonly src: string;
  readonly name: string;
  readonly description: string;
}

const avatars: readonly AssistantAvatar[] = [
  { src: sounders, name: 'Sounders', description: '2022 年在犬隻跳水賽跳出 11.12 公尺，獲金氏世界紀錄認證。' },
  { src: slingshot, name: 'Slingshot', description: '曾保持犬隻跳水的金氏世界紀錄，也參加飛球接力和短跑競賽。' },
  { src: fleetfoot, name: 'Fleetfoot', description: '正式名 Courtenay Fleetfoot of Pennyworth，1964 年奪下 Westminster 犬展總冠軍。' },
  { src: bourbon, name: 'Bourbon', description: '2020 年奪下 AKC 全國錦標賽總冠軍，2025 年獲 Westminster 犬展總亞軍。' },
  { src: zorro, name: 'Zorro', description: '獨立遊戲《Whippet At Large》開發者飼養的慧比特犬，也是遊戲主角的原型。' },
];

// 以 session ID 作為 FNV-1a 的輸入，重開對話或換瀏覽器時仍會選到同一張。
export function avatarForSession(sessionId: string): AssistantAvatar {
  let hash = 2166136261;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = Math.imul(hash ^ sessionId.charCodeAt(i), 16777619);
  }
  return avatars[(hash >>> 0) % avatars.length];
}
