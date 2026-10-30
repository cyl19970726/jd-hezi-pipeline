/** Mark the current JavaScript realm before navigation. */
export function markDocumentForNavigation(marker: string) {
  (window as any).__heziDocumentNavigationMarker = marker;
  document.documentElement.setAttribute("data-hezi-reload", marker);
}

/** A full document navigation creates a new Window realm; SPA navigation does not. */
export function didDocumentSurviveNavigation(marker: string) {
  return (window as any).__heziDocumentNavigationMarker === marker;
}
