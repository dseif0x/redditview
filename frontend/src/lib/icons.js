// Ionicons are bundled as data-URI strings; the Icon component inlines the
// SVG markup so the app stays fully self-contained (no CDN fetches) and the
// icons tint via currentColor, exactly like ion-icon did.
import {
  playOutline,
  pauseOutline,
  volumeMuteOutline,
  volumeHighOutline,
  expandOutline,
  star,
  starOutline,
  arrowUpCircle,
  arrowUpCircleOutline,
  arrowDownCircle,
  arrowDownCircleOutline,
  chatbubbleOutline,
  closeOutline,
  albumsOutline,
  settingsOutline,
  chevronExpandOutline,
  eyeOutline,
} from 'ionicons/icons';

const ICONS = {
  'play-outline': playOutline,
  'pause-outline': pauseOutline,
  'volume-mute-outline': volumeMuteOutline,
  'volume-high-outline': volumeHighOutline,
  'expand-outline': expandOutline,
  star,
  'star-outline': starOutline,
  'arrow-up-circle': arrowUpCircle,
  'arrow-up-circle-outline': arrowUpCircleOutline,
  'arrow-down-circle': arrowDownCircle,
  'arrow-down-circle-outline': arrowDownCircleOutline,
  'chatbubble-outline': chatbubbleOutline,
  'close-outline': closeOutline,
  'albums-outline': albumsOutline,
  'settings-outline': settingsOutline,
  'chevron-expand-outline': chevronExpandOutline,
  'eye-outline': eyeOutline,
};

export function iconSvg(name) {
  const src = ICONS[name] || '';
  return src.replace(/^data:image\/svg\+xml;utf8,/, '');
}
