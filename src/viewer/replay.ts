import type { playerConfig } from '@rrweb/replay';
import {
  EventType,
  IncrementalSource,
  type eventWithTime,
  type scrollData,
} from '@rrweb/types';

const scrollPlugin = 'floebrowser:live-scroll';

/** Keep scroll positions in replay order, without rrweb's second animation. */
export function liveEvent(
  event: eventWithTime,
  timestamp: number,
): eventWithTime {
  if (
    event.type === EventType.IncrementalSnapshot &&
    event.data.source === IncrementalSource.Scroll
  )
    return {
      type: EventType.Plugin,
      timestamp,
      data: { plugin: scrollPlugin, payload: event.data },
    };
  return { ...event, timestamp };
}

export const liveScroll: NonNullable<playerConfig['plugins']>[number] = {
  handler(event, _isSync, { replayer }) {
    if (event.type !== EventType.Plugin || event.data.plugin !== scrollPlugin)
      return;
    const { id, x, y } = event.data.payload as scrollData;
    const node = replayer.getMirror().getNode(id);
    if (!node?.isConnected) return;
    const target =
      node.nodeType === 9 ? (node as Document).defaultView : (node as Element);
    // Source CSS can request smooth scrolling too. These are already-observed
    // positions, so even that animation must only run at the source.
    target?.scrollTo({ left: x, top: y, behavior: 'instant' });
  },
};
