/** スマホなどで見るための Web 版（見るだけ）。`vite build --mode web` で作る。間取りはビルドに埋め込み、変更は保存しない */
export const WEB = import.meta.env.MODE === 'web';

/** Web 版で最初に立つ階（URL の #1f・#2f・#3f）。俯瞰はなく、全部の階をつなげてウォークスルーで見る */
export const WEB_FLOORS = ['1f', '2f', '3f'];
export const WEB_FLOOR = WEB ? Math.max(0, WEB_FLOORS.indexOf(location.hash.replace('#', '').toLowerCase())) : 0;

/** Web 版で、階を選んだときに立つ部屋 */
export const WEB_START_ROOMS = ['1f-hall', '2f-ldk', '3f-hall'];
