// 電気図の「スイッチの一覧」: ボタンが複数ある・スイッチが並んでいる所のスクショ（notes/electrical/switch-images/）と、
// スクショに書いた記号（A・B…）とスイッチの家具 id。ボタンと照明のつながりは間取りの circuits から書く
export const SWITCH_SHOTS: { floor: string; where: string; img: string; switches: [string, string][] }[] = [
  { floor: '1 階', where: '洗面脱衣室（浴室の扉の横）', img: 'sw-1f-bath.jpg', switches: [['A', 'std-1f-sw-bath']] },
  { floor: '1 階', where: 'シューズクローク（ホールからの入口の北の壁）', img: 'sw-1f-sic.jpg', switches: [['B', 'sic-sw-1'], ['C', 'sic-sw-2']] },
  { floor: '2 階', where: 'キッチン（パントリーの入口の左）', img: 'sw-2f-kitchen.jpg', switches: [['D', 'std-2f-sw-kitchen']] },
];
