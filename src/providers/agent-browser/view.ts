export function browserViewScript(
  selector: string | undefined,
  offset: number,
  controlOffset = 0,
): string {
  return `(() => {
    const root = ${JSON.stringify(selector ?? null)} ? document.querySelector(${JSON.stringify(selector ?? null)}) : document.body;
    if (!root) return { missing: true };
    const text = String(root.innerText ?? '');
    const path = (element) => {
      const parts = [];
      for (let node = element; node && node !== document; node = node.parentElement) {
        if (node.id && /^[a-zA-Z_][a-zA-Z0-9_-]*$/.test(node.id)) {
          parts.unshift('#' + node.id);
          break;
        }
        const siblings = node.parentElement ? [...node.parentElement.children].filter((item) => item.tagName === node.tagName) : [node];
        parts.unshift(node.tagName.toLowerCase() + ':nth-of-type(' + (siblings.indexOf(node) + 1) + ')');
      }
      const value = parts.join(' > ');
      return value.length <= 500 && document.querySelector(value) === element ? value : null;
    };
    const controls = [];
    const scrollAreas = [];
    let controlsTotal = 0;
    let scrollAreasTotal = 0;
    for (const element of root.querySelectorAll?.('*') ?? []) {
      try {
      const box = element.getBoundingClientRect();
      if (!box.width || !box.height) continue;
      const style = getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      if (/(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 40) {
        if (scrollAreasTotal >= ${controlOffset} && scrollAreasTotal < ${controlOffset} + 20) {
          const selector = path(element);
          if (selector) scrollAreas.push({ selector, height: element.scrollHeight, viewport: element.clientHeight });
        }
        scrollAreasTotal++;
      }
      if (!(/^(A|BUTTON|INPUT|SELECT|TEXTAREA)$/.test(element.tagName) || ['button', 'link', 'tab', 'radio'].includes(element.getAttribute('role')) || element.hasAttribute('tabindex') || style.cursor === 'pointer')) continue;
      if (style.cursor === 'pointer' && getComputedStyle(element.parentElement ?? element).cursor === 'pointer' && !element.hasAttribute('role') && !element.hasAttribute('tabindex')) continue;
      const label = String(element.getAttribute('aria-label') || (/^(INPUT|TEXTAREA|SELECT)$/.test(element.tagName) ? element.getAttribute('placeholder') || element.labels?.[0]?.innerText : element.innerText) || '').trim().replace(/\\s+/g, ' ').slice(0, 120);
      if (!label || element.matches('[contenteditable]')) continue;
      if (controlsTotal >= ${controlOffset} && controlsTotal < ${controlOffset} + 80) {
        const selector = path(element);
        if (selector) controls.push({ selector, label });
      }
      controlsTotal++;
      } catch {}
    }
    return { text: text.slice(${offset}, ${offset} + 16000), total: text.length, controls, controlsTotal, scrollAreas, scrollAreasTotal };
  })()`;
}
