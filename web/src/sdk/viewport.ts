import { useSyncExternalStore } from 'react'

/**
 * Below 768px is a `phone`; from 768px is a `tablet`, unless at least 1024px wide with no coarse pointer (`desktop`).
 * Wide touch devices, including touch-screen laptops and Chromebooks, stay tablets by design, even with a mouse.
 * On a phone the sidebar and panel overlay the conversation; on a tablet the sidebar docks and the panel overlays;
 * on a desktop both dock.
 * Below `desktop` their open state is the tab's own, so a phone never folds away the desktop's; it starts closed, except
 * a tablet's docked sidebar (`ownDefault` in actions.ts).
 */
export type Viewport = 'phone' | 'tablet' | 'desktop'

let queries: { tablet: MediaQueryList; desktop: MediaQueryList; touch: MediaQueryList } | undefined
const media = () =>
  (queries ??= {
    tablet: matchMedia('(min-width: 768px)'),
    desktop: matchMedia('(min-width: 1024px)'),
    touch: matchMedia('(any-pointer: coarse)'),
  })

export function viewport(): Viewport {
  const { tablet, desktop, touch } = media()
  return desktop.matches && !touch.matches ? 'desktop' : tablet.matches ? 'tablet' : 'phone'
}

function subscribe(listener: () => void) {
  const { tablet, desktop, touch } = media()
  tablet.addEventListener('change', listener)
  desktop.addEventListener('change', listener)
  touch.addEventListener('change', listener)
  return () => {
    tablet.removeEventListener('change', listener)
    desktop.removeEventListener('change', listener)
    touch.removeEventListener('change', listener)
  }
}

export const useViewport = () => useSyncExternalStore(subscribe, viewport)

/** Whether the device types on a touch keyboard, which focusing an input would slide up over the page. */
export const touchKeyboard = () => matchMedia('(pointer: coarse)').matches

/** Whether `region` overlays the conversation rather than docking beside it. */
export const overlays = (region: 'sidebar' | 'panels', on: Viewport = viewport()) =>
  on === 'phone' || (region === 'panels' && on === 'tablet')
