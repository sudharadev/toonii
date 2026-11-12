'use strict';
// Custom right-click menu. Main sends a spec, the page renders it and reports its size so
// main can place the window at the cursor; a pick or Esc goes back to main.
const api = window.menu;
const menuEl = document.getElementById('menu');

const svgIcon = (name) => {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'i');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.append(use);
  return svg;
};

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
}

function renderItem(it) {
  if (it.type === 'separator') return el('div', 'sep');

  if (it.type === 'swatches' || it.type === 'segments') {
    const g = el('div', 'group');
    g.append(el('h4', '', it.label));
    const row = el('div', it.type);
    row.setAttribute('role', 'radiogroup');
    row.setAttribute('aria-label', it.label);
    for (const o of it.options) {
      const b = el('button', '', it.type === 'segments' ? o.label : undefined);
      b.setAttribute('role', 'radio');
      b.setAttribute('aria-checked', String(o.value === it.value));
      b.title = o.label;
      if (o.color) b.style.setProperty('--sw', o.color);
      b.addEventListener('click', () => api.pick(it.id, o.value));
      row.append(b);
    }
    g.append(row);
    return g;
  }

  const b = el('button', 'item');
  b.setAttribute('role', it.toggle ? 'menuitemcheckbox' : 'menuitem');
  if (it.toggle) b.setAttribute('aria-checked', String(!!it.checked));
  if (it.checked) b.classList.add('on');
  if (it.danger) b.classList.add('danger');
  if (it.suggest) b.classList.add('suggest');
  b.disabled = it.enabled === false;
  if (it.icon) b.append(svgIcon(it.icon));
  b.append(el('span', 'label', it.label));
  if (it.toggle) b.append(el('span', 'check'));
  else if (it.hint) b.append(el('span', 'hint', it.hint));
  b.addEventListener('click', () => api.pick(it.id));
  return b;
}

api.onShow((spec) => {
  document.documentElement.style.setProperty('--hover', spec.accent || '#FFD84D');
  menuEl.replaceChildren(...spec.items.map(renderItem));
  focusIndex = -1;
  menuEl.classList.remove('show');
  // Measure now, not in a frame callback: WebKit (macOS) runs no frames while hidden.
  const r = menuEl.getBoundingClientRect();
  api.ready(Math.ceil(r.width), Math.ceil(r.height));
});

// main sets this once the window is placed, so the pop starts from the cursor corner
window.addEventListener('focus', () => {
  void menuEl.offsetWidth;
  menuEl.classList.add('show');
});

// ---------- keyboard ----------

let focusIndex = -1;
const items = () => [...menuEl.querySelectorAll('.item:not(:disabled)')];

function moveFocus(step) {
  const list = items();
  if (!list.length) return;
  focusIndex = (focusIndex + step + list.length) % list.length;
  list.forEach((b, i) => b.classList.toggle('focus', i === focusIndex));
  list[focusIndex].focus({ preventScroll: true });
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); api.close(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); moveFocus(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); moveFocus(-1); }
});
document.addEventListener('mousemove', () => {
  for (const b of menuEl.querySelectorAll('.focus')) b.classList.remove('focus');
  focusIndex = -1;
});
document.addEventListener('contextmenu', (e) => e.preventDefault());
// A click on the transparent margin closes the menu, like clicking outside it.
document.addEventListener('mousedown', (e) => { if (!menuEl.contains(e.target)) api.close(); });
