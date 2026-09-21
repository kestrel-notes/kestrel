import type { KestrelApi } from '../../shared/types'

declare global {
  interface Window {
    kestrel: KestrelApi
  }
}

export {}