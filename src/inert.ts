// While a full-screen workspace (the drawing editor or the drawing viewer) is open, everything around it
// is inert, so Tab and screen readers stay inside it. The toast keeps announcing.
export function setOthersInert(element: HTMLElement, on: boolean) {
  const body = element.ownerDocument.body;
  for (let node: HTMLElement | null = element; node && node !== body; node = node.parentElement) {
    for (const sibling of Array.from(node.parentElement?.children ?? [])) {
      if (sibling !== node && sibling.id !== 'toast') sibling.toggleAttribute('inert', on);
    }
  }
}
