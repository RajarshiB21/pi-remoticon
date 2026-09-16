// Adapted from https://github.com/mkaz/pi-mkaz-sidebar (MIT, (c) 2026 Michael Kazmierczak)
// src/split-pane.ts. Deltas: options are renamed `width`/`minMain` (upstream:
// `sidebarWidth`/`minMainWidth`); `sidebarWidth` becomes `let` and `overlayOptions.width`
// is mutated by `rebuild(width)`, which re-creates the reserved column while attached;
// `buildSplitRoot(original, sidebarWidth, minMain, visible)` is exported for tests, with
// the visibility predicate passed in so the controller's enabled-aware one still governs.
import { HStack, isViewportTUI, type Component, type OverlayOptions, type TUI } from "@earendil-works/pi-tui";

export const DEFAULT_SIDEBAR_WIDTH = 44;
export const MIN_SIDEBAR_WIDTH = 28;
export const MAX_SIDEBAR_WIDTH = 60;
export const MIN_MAIN_WIDTH = 64;

const REGULAR_RENDER_ADAPTER = Symbol("pi-remoticon-sidebar.regular-render-adapter");
const FULLSCREEN_LAYOUT_ADAPTER = Symbol("pi-remoticon-sidebar.fullscreen-layout-adapter");

type RenderFunction = TUI["render"];

interface RegularRenderAdapterState {
  owner: object;
  baseRender: RenderFunction;
}

interface FullscreenLayoutAdapterState {
  owner: object;
  originalRoot: Component;
  splitRoot: Component;
}

type AdaptedTui = TUI & {
  [REGULAR_RENDER_ADAPTER]?: RegularRenderAdapterState;
  [FULLSCREEN_LAYOUT_ADAPTER]?: FullscreenLayoutAdapterState;
  layoutRoot?: Component;
};

export interface SplitControllerOptions {
  width?: number;
  minMain?: number;
  onError?(error: unknown): void;
}

export interface SplitController {
  attach(tui: TUI): void;
  show(): void;
  hide(): void;
  isEnabled(): boolean;
  overlayOptions(): OverlayOptions;
  requestRender(): void;
  rebuild(width: number): void;
  dispose(): void;
}

/** The reserved-column root: main keeps the rest of the width, the column takes
 *  `sidebarWidth` and is excluded entirely when `visible` says no.
 *
 *  Deltas from upstream: main's `minSize` is 0 rather than 64, and the floor is no
 *  longer a parameter here. Upstream's static 64 binds even when the column is
 *  hidden, so on a terminal narrower than 64 the main column renders 64 cells wide
 *  and the terminal clips its right edge. The caller's `visible` predicate already
 *  guarantees main >= 64 whenever the column is shown (it requires
 *  `width >= 64 + sidebarWidth`), so the floor only ever did harm. */
export const buildSplitRoot = (originalRoot: Component, sidebarWidth: number, visible: (width: number) => boolean): HStack =>
  new HStack([
    { component: originalRoot, basis: 0, grow: 1, shrink: 1, minSize: 0 },
    {
      component: { render: () => [], invalidate() {} },
      basis: sidebarWidth,
      grow: 0,
      shrink: 1,
      visible: ({ width }) => visible(width),
    },
  ]);

export function createSplitController(options: SplitControllerOptions = {}): SplitController {
  const clampWidth = (w: number) => Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, Math.trunc(w)));
  let sidebarWidth = clampWidth(options.width ?? DEFAULT_SIDEBAR_WIDTH);
  const minMainWidth = Math.max(1, Math.trunc(options.minMain ?? MIN_MAIN_WIDTH));
  const adapterOwner = {};

  let tui: TUI | undefined;
  let enabled = false;
  let disposed = false;
  /** True once an adapter has actually taken the width from the main column. The overlay may
   *  only paint while this holds: if pi's layout root cannot be found (a renamed private field
   *  after a pi upgrade), painting anyway would cover live main content instead of a reserved
   *  column, which is the partial screen state the contract forbids. */
  let reserved = false;
  let reportedUnreserved = false;

  const isVisibleAtWidth = (width: number): boolean => enabled && reserved && width >= minMainWidth + sidebarWidth;
  const overlayOptions: OverlayOptions = {
    anchor: "top-right",
    width: sidebarWidth,
    maxHeight: "100%",
    margin: 0,
    nonCapturing: true,
    visible: isVisibleAtWidth,
  };

  const findRegularRender = (nextTui: TUI): RenderFunction | undefined => {
    let prototype = Object.getPrototypeOf(nextTui) as object | null;
    if ((prototype as { constructor?: { name?: string } } | null)?.constructor?.name !== "TuiMainScreen") {
      return undefined;
    }
    while (prototype) {
      const render = Object.getOwnPropertyDescriptor(prototype, "render")?.value;
      if (typeof render === "function") return render as RenderFunction;
      prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    return undefined;
  };

  const syncRegularRenderAdapter = () => {
    if (!tui || tui.mode !== "regular") return;
    const adaptedTui = tui as AdaptedTui;
    const current = adaptedTui[REGULAR_RENDER_ADAPTER];
    if (current) return;
    const baseRender = findRegularRender(tui);
    if (!baseRender) return;
    adaptedTui[REGULAR_RENDER_ADAPTER] = { owner: adapterOwner, baseRender };
    adaptedTui.render = (width: number) =>
      Reflect.apply(baseRender, tui, [isVisibleAtWidth(width) ? width - sidebarWidth : width]);
    reserved = true;
  };

  const restoreRegularRenderAdapter = () => {
    if (!tui) return;
    const adaptedTui = tui as AdaptedTui;
    const current = adaptedTui[REGULAR_RENDER_ADAPTER];
    if (current?.owner !== adapterOwner) return;
    adaptedTui.render = current.baseRender;
    adaptedTui[REGULAR_RENDER_ADAPTER] = undefined;
    reserved = false;
  };

  const syncFullscreenLayoutAdapter = () => {
    if (!tui || tui.mode !== "fullscreen" || !isViewportTUI(tui)) return;
    const adaptedTui = tui as AdaptedTui;
    const current = adaptedTui[FULLSCREEN_LAYOUT_ADAPTER];
    if (current && current.owner !== adapterOwner) { reserved = false; return; }
    const root = adaptedTui.layoutRoot;
    if (current?.owner === adapterOwner && root === current.splitRoot) { reserved = true; return; }
    if (!root) {
      // The private layout root is gone (a pi upgrade renamed it). Report once and stay
      // unreserved, so the extension never paints over a column it did not take.
      if (!reportedUnreserved) {
        reportedUnreserved = true;
        options.onError?.(new Error("pi's fullscreen layout root is unavailable; the sidebar column was not reserved"));
      }
      reserved = false;
      return;
    }
    const splitRoot = buildSplitRoot(root, sidebarWidth, isVisibleAtWidth);
    tui.setLayoutRoot(splitRoot);
    adaptedTui[FULLSCREEN_LAYOUT_ADAPTER] = { owner: adapterOwner, originalRoot: root, splitRoot };
    reserved = true;
  };

  const restoreFullscreenLayoutAdapter = () => {
    if (!tui || !isViewportTUI(tui)) return;
    const adaptedTui = tui as AdaptedTui;
    const current = adaptedTui[FULLSCREEN_LAYOUT_ADAPTER];
    if (current?.owner !== adapterOwner) return;
    if (adaptedTui.layoutRoot === current.splitRoot) tui.setLayoutRoot(current.originalRoot);
    adaptedTui[FULLSCREEN_LAYOUT_ADAPTER] = undefined;
    reserved = false;
  };

  return {
    attach(nextTui) {
      if (disposed) throw new Error("Cannot attach a disposed split pane");
      if (tui === nextTui) return;
      if (tui) throw new Error("Split pane is already attached to another TUI");
      tui = nextTui;
      syncRegularRenderAdapter();
      syncFullscreenLayoutAdapter();
      nextTui.requestRender();
    },
    show() {
      if (disposed || enabled) return;
      enabled = true;
      syncRegularRenderAdapter();
      syncFullscreenLayoutAdapter();
      tui?.requestRender();
    },
    hide() {
      if (!enabled) return;
      enabled = false;
      tui?.requestRender();
    },
    isEnabled: () => enabled,
    overlayOptions: () => overlayOptions,
    requestRender: () => tui?.requestRender(),
    rebuild(width) {
      if (disposed) throw new Error("Cannot rebuild a disposed split pane");
      const next = clampWidth(width);
      if (next === sidebarWidth) return;
      const wasEnabled = enabled;
      if (wasEnabled) {
        restoreRegularRenderAdapter();
        restoreFullscreenLayoutAdapter();
        enabled = false;
      }
      sidebarWidth = next;
      overlayOptions.width = sidebarWidth;            // overlayOptions is the mutable object the overlay reads
      if (wasEnabled) {
        enabled = true;
        syncRegularRenderAdapter();
        syncFullscreenLayoutAdapter();
      }
      tui?.requestRender();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      restoreRegularRenderAdapter();
      restoreFullscreenLayoutAdapter();
      tui?.requestRender();
      tui = undefined;
    },
  };
}
