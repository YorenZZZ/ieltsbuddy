const instances = new WeakMap();
const liveInstances = new Set();
const viewportGap = 10;
const menuGap = 6;

export function chooseSelectDirection({ spaceAbove, spaceBelow, desiredHeight }) {
  const needed = Math.min(Math.max(desiredHeight, 0), 240);
  return spaceBelow < needed && spaceAbove > spaceBelow ? 'up' : 'down';
}

export function selectMenuGeometry({ trigger, viewportWidth, viewportHeight, desiredHeight, desiredWidth }) {
  const spaceAbove = Math.max(0, trigger.top - viewportGap - menuGap);
  const spaceBelow = Math.max(0, viewportHeight - trigger.bottom - viewportGap - menuGap);
  const direction = chooseSelectDirection({ spaceAbove, spaceBelow, desiredHeight });
  const availableHeight = Math.max(88, direction === 'up' ? spaceAbove : spaceBelow);
  const height = Math.min(desiredHeight, availableHeight, 320);
  const width = Math.min(Math.max(trigger.width, desiredWidth), viewportWidth - viewportGap * 2);
  const left = Math.min(Math.max(viewportGap, trigger.left), viewportWidth - viewportGap - width);
  const top = direction === 'up'
    ? Math.max(viewportGap, trigger.top - menuGap - height)
    : Math.min(viewportHeight - viewportGap - height, trigger.bottom + menuGap);
  return { direction, height, width, left, top };
}

function optionLabel(option) {
  return option.label || option.textContent?.trim() || option.value || '未命名选项';
}

export function isSelectPlaceholder(option) {
  if (!option || option.value !== '') return false;
  return /^(?:请(?:先)?选择|选择)/u.test(optionLabel(option));
}

function labelFor(select) {
  if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
  const explicit = select.id ? document.querySelector(`label[for="${CSS.escape(select.id)}"]`) : null;
  const label = explicit || select.closest('label');
  if (!label) return '选择选项';
  const clone = label.cloneNode(true);
  clone.querySelectorAll('select, input, textarea, button, .workbench-select').forEach((node) => node.remove());
  return clone.textContent.trim() || '选择选项';
}

export function menuHostFor(select) {
  return select.closest('dialog[open]') || document.body;
}

// 可输入下拉的候选：去空、去重；有输入时按包含匹配筛选（不区分大小写），点箭头或刚聚焦时列出全部。
export function filterComboValues(values, query, showAll = false) {
  const unique = [...new Set(values.map((value) => String(value ?? '').trim()).filter(Boolean))];
  const needle = String(query ?? '').trim().toLocaleLowerCase();
  if (showAll || !needle) return unique;
  return unique.filter((value) => value.toLocaleLowerCase().includes(needle));
}

function isComboEligible(input) {
  return input instanceof HTMLInputElement
    && Boolean(input.getAttribute('list'))
    && ['text', 'search'].includes(input.type)
    && !input.matches('[data-native-list]');
}

function isEligible(select) {
  return select instanceof HTMLSelectElement
    && !select.multiple
    && select.size <= 1
    && !select.matches('[data-native-select], .workbench-select-native');
}

class WorkbenchSelect {
  constructor(select) {
    this.select = select;
    this.control = select;
    this.activeIndex = -1;
    this.opened = false;
    this.closeTimer = 0;
    this.fallbackOpen = false;
    this.typeahead = '';
    this.typeaheadTimer = 0;

    this.wrapper = document.createElement('span');
    this.wrapper.className = 'workbench-select';
    if (select.classList.contains('mobile-picker')) this.wrapper.classList.add('mobile-picker');
    this.wrapper.dataset.direction = 'down';
    this.wrapper.dataset.open = 'false';

    this.trigger = document.createElement('button');
    this.trigger.type = 'button';
    this.trigger.className = 'workbench-select-trigger';
    this.trigger.setAttribute('role', 'combobox');
    this.trigger.setAttribute('aria-haspopup', 'listbox');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.setAttribute('aria-label', labelFor(select));
    this.trigger.innerHTML = '<span class="workbench-select-value"></span><span class="workbench-select-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.5 6 4.5 4 4.5-4"/></svg></span>';
    this.value = this.trigger.querySelector('.workbench-select-value');

    this.menu = document.createElement('div');
    this.menu.className = 'workbench-select-menu';
    this.menu.dataset.selectId = select.id;
    this.menu.setAttribute('role', 'listbox');
    this.menu.setAttribute('popover', 'manual');
    this.menu.id = `workbench-select-menu-${WorkbenchSelect.sequence += 1}`;
    this.trigger.setAttribute('aria-controls', this.menu.id);

    select.before(this.wrapper);
    this.wrapper.append(select, this.trigger);
    select.classList.add('workbench-select-native');
    select.dataset.workbenchSelectReady = 'true';
    select.tabIndex = -1;
    select.setAttribute('aria-hidden', 'true');
    document.body.append(this.menu);

    this.onTriggerClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.opened ? this.close({ restoreFocus: true }) : this.open();
    };
    this.onTriggerKeydown = (event) => this.handleKeydown(event);
    this.onMenuPointerdown = (event) => event.preventDefault();
    this.onMenuClick = (event) => {
      const item = event.target.closest('[data-option-index]');
      if (!item || item.getAttribute('aria-disabled') === 'true') return;
      this.commit(Number(item.dataset.optionIndex));
    };
    this.onSelectChange = () => this.sync();
    this.onSelectFocus = () => this.trigger.focus();
    this.onInvalid = (event) => {
      event.preventDefault();
      this.wrapper.dataset.invalid = 'true';
      this.trigger.focus();
    };
    this.onFormReset = () => queueMicrotask(() => this.sync());
    this.onMutate = () => this.sync();

    this.trigger.addEventListener('click', this.onTriggerClick);
    this.trigger.addEventListener('keydown', this.onTriggerKeydown);
    this.menu.addEventListener('pointerdown', this.onMenuPointerdown);
    this.menu.addEventListener('click', this.onMenuClick);
    select.addEventListener('input', this.onSelectChange);
    select.addEventListener('change', this.onSelectChange);
    select.addEventListener('focus', this.onSelectFocus);
    select.addEventListener('invalid', this.onInvalid);
    this.form = select.form;
    this.form?.addEventListener('reset', this.onFormReset);
    this.observer = new MutationObserver(this.onMutate);
    this.observer.observe(select, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'class', 'style', 'label', 'selected'] });
    liveInstances.add(this);
    instances.set(select, this);
    this.sync();
  }

  sync() {
    if (!this.select.isConnected) return this.destroy();
    const selected = this.select.selectedOptions[0];
    this.value.textContent = selected ? optionLabel(selected) : '请选择';
    this.value.classList.toggle('is-placeholder', !this.select.value);
    this.trigger.disabled = this.select.disabled;
    this.trigger.setAttribute('aria-required', String(this.select.required));
    this.wrapper.hidden = this.select.hidden || this.select.style.display === 'none' || this.select.classList.contains('hidden');
    if (this.select.validity.valid) this.wrapper.dataset.invalid = 'false';
    if (this.opened) {
      this.renderOptions();
      this.position();
    }
  }

  renderOptions() {
    const selectedIndex = this.select.selectedIndex;
    this.menu.replaceChildren();
    let optionIndex = 0;
    for (const child of this.select.children) {
      if (child instanceof HTMLOptGroupElement) {
        const group = document.createElement('div');
        group.className = 'workbench-select-group';
        group.textContent = child.label;
        this.menu.append(group);
        for (const option of child.children) {
          if (!isSelectPlaceholder(option)) this.menu.append(this.optionElement(option, optionIndex, selectedIndex));
          optionIndex += 1;
        }
      } else if (child instanceof HTMLOptionElement) {
        if (!isSelectPlaceholder(child)) this.menu.append(this.optionElement(child, optionIndex, selectedIndex));
        optionIndex += 1;
      }
    }
    const selected = this.select.options[selectedIndex];
    const active = this.select.options[this.activeIndex];
    if (!active || active.disabled || isSelectPlaceholder(active)) {
      this.activeIndex = selected && !selected.disabled && !isSelectPlaceholder(selected)
        ? selectedIndex
        : this.nextEnabled(-1, 1);
    }
    this.paintActive();
  }

  optionElement(option, index, selectedIndex) {
    const item = document.createElement('div');
    item.className = 'workbench-select-option';
    item.id = `${this.menu.id}-option-${index}`;
    item.dataset.optionIndex = String(index);
    item.setAttribute('role', 'option');
    item.setAttribute('aria-selected', String(index === selectedIndex));
    item.setAttribute('aria-disabled', String(option.disabled));
    item.innerHTML = '<span></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';
    item.querySelector('span').textContent = optionLabel(option);
    return item;
  }

  open() {
    if (this.select.disabled || !this.select.options.length) return;
    closeOpenSelect(this);
    clearTimeout(this.closeTimer);
    this.sync();
    this.renderOptions();
    this.opened = true;
    openInstance = this;
    this.wrapper.dataset.open = 'true';
    this.trigger.setAttribute('aria-expanded', 'true');
    this.menu.classList.remove('is-closing');
    this.menu.classList.add('is-opening');
    this.fallbackOpen = false;
    // 模态 dialog 会让其外部节点变为 inert：浮层必须挂在所在 dialog 内，否则选项与滚动条收不到指针事件。
    const host = menuHostFor(this.select);
    if (this.menu.parentElement !== host) host.append(this.menu);
    try { this.menu.showPopover(); }
    catch {
      this.fallbackOpen = true;
      this.menu.hidden = false;
    }
    this.position();
    requestAnimationFrame(() => {
      if (!this.opened) return;
      this.menu.classList.remove('is-opening');
      this.menu.classList.add('is-visible');
      this.scrollActiveIntoView();
    });
  }

  close({ restoreFocus = false, immediate = false } = {}) {
    if (!this.opened && !this.menu.classList.contains('is-visible')) return;
    this.opened = false;
    if (openInstance === this) openInstance = null;
    this.wrapper.dataset.open = 'false';
    this.wrapper.dataset.direction = 'down';
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.removeAttribute('aria-activedescendant');
    this.menu.classList.remove('is-visible', 'is-opening');
    this.menu.classList.add('is-closing');
    clearTimeout(this.closeTimer);
    const finish = () => {
      this.menu.classList.remove('is-closing');
      if (this.fallbackOpen) {
        this.menu.hidden = true;
        this.fallbackOpen = false;
        return;
      }
      try { if (this.menu.matches(':popover-open')) this.menu.hidePopover(); }
      catch { this.menu.hidden = true; }
      if (!this.menu.hasAttribute('popover')) this.menu.hidden = true;
    };
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else this.closeTimer = setTimeout(finish, 150);
    if (restoreFocus) this.trigger.focus({ preventScroll: true });
  }

  position() {
    if (!this.opened) return;
    const trigger = this.trigger.getBoundingClientRect();
    if (!trigger.width || !trigger.height) return this.close({ immediate: true });
    this.menu.style.width = `${Math.min(trigger.width, innerWidth - viewportGap * 2)}px`;
    this.menu.style.maxHeight = '320px';
    const desiredHeight = Math.min(Math.max(this.menu.scrollHeight, 44), 320);
    const desiredWidth = Math.max(trigger.width, Math.min(this.menu.scrollWidth, 360));
    const geometry = selectMenuGeometry({ trigger, viewportWidth: innerWidth, viewportHeight: innerHeight, desiredHeight, desiredWidth });
    this.wrapper.dataset.direction = geometry.direction;
    this.menu.dataset.direction = geometry.direction;
    this.menu.style.left = `${geometry.left}px`;
    this.menu.style.top = `${geometry.top}px`;
    this.menu.style.width = `${geometry.width}px`;
    this.menu.style.maxHeight = `${geometry.height}px`;
  }

  nextEnabled(from, step) {
    const options = [...this.select.options];
    if (!options.length) return -1;
    let index = from;
    for (let checked = 0; checked < options.length; checked += 1) {
      index = (index + step + options.length) % options.length;
      if (!options[index].disabled && !isSelectPlaceholder(options[index])) return index;
    }
    return -1;
  }

  move(step) {
    this.activeIndex = this.nextEnabled(this.activeIndex, step);
    this.paintActive();
    this.scrollActiveIntoView();
  }

  moveToEdge(last) {
    this.activeIndex = this.nextEnabled(last ? 0 : this.select.options.length - 1, last ? -1 : 1);
    this.paintActive();
    this.scrollActiveIntoView();
  }

  paintActive() {
    this.menu.querySelectorAll('[data-option-index]').forEach((item) => {
      item.classList.toggle('is-active', Number(item.dataset.optionIndex) === this.activeIndex);
    });
    if (this.activeIndex >= 0) this.trigger.setAttribute('aria-activedescendant', `${this.menu.id}-option-${this.activeIndex}`);
  }

  scrollActiveIntoView() {
    this.menu.querySelector(`[data-option-index="${this.activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  commit(index) {
    const option = this.select.options[index];
    if (!option || option.disabled) return;
    const changed = this.select.selectedIndex !== index;
    this.select.selectedIndex = index;
    this.wrapper.dataset.invalid = 'false';
    this.sync();
    if (changed) {
      this.select.dispatchEvent(new Event('input', { bubbles: true }));
      this.select.dispatchEvent(new Event('change', { bubbles: true }));
    }
    this.close({ restoreFocus: true });
  }

  typeaheadSearch(character) {
    clearTimeout(this.typeaheadTimer);
    this.typeahead += character.toLocaleLowerCase();
    this.typeaheadTimer = setTimeout(() => { this.typeahead = ''; }, 650);
    const options = [...this.select.options];
    const start = Math.max(0, this.activeIndex + 1);
    const ordered = [...options.slice(start), ...options.slice(0, start)];
    const match = ordered.find((option) => !option.disabled && !isSelectPlaceholder(option) && optionLabel(option).toLocaleLowerCase().startsWith(this.typeahead));
    if (!match) return;
    this.activeIndex = options.indexOf(match);
    this.paintActive();
    this.scrollActiveIntoView();
  }

  handleKeydown(event) {
    if (event.key === 'Escape' && this.opened) {
      event.preventDefault();
      event.stopPropagation();
      return this.close({ restoreFocus: true });
    }
    if (event.key === 'Tab') return this.close({ immediate: true });
    if (!this.opened && ['Enter', ' ', 'ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault();
      this.open();
      if (event.key === 'ArrowUp') this.moveToEdge(true);
      return;
    }
    if (!this.opened) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.move(event.key === 'ArrowDown' ? 1 : -1);
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      this.moveToEdge(event.key === 'End');
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      this.commit(this.activeIndex);
    } else if (event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey) {
      this.typeaheadSearch(event.key);
    }
  }

  destroy() {
    this.close({ immediate: true });
    this.observer.disconnect();
    this.form?.removeEventListener('reset', this.onFormReset);
    liveInstances.delete(this);
    this.menu.remove();
  }
}

WorkbenchSelect.sequence = 0;
let openInstance = null;

// 可输入下拉：带 list 属性的输入框（候选取自 <datalist>，也允许手动输入新值）。
// 移走 list 属性，避免浏览器弹出不受主题控制的原生联想框；候选浮层与单选下拉共用 .workbench-select-menu
// 的外观、定位与「挂进所在 dialog」规则。输入框本身仍承载表单值、校验与 input / change 事件。
class WorkbenchCombo {
  constructor(input) {
    this.input = input;
    this.control = input;
    this.listId = input.getAttribute('list');
    this.values = [];
    this.activeIndex = -1;
    this.opened = false;
    this.showAll = false;
    this.committing = false;
    this.closeTimer = 0;
    this.fallbackOpen = false;

    this.wrapper = document.createElement('span');
    this.wrapper.className = 'workbench-combo';
    this.wrapper.dataset.direction = 'down';
    this.wrapper.dataset.open = 'false';

    this.toggle = document.createElement('button');
    this.toggle.type = 'button';
    this.toggle.className = 'workbench-combo-toggle';
    this.toggle.tabIndex = -1;
    this.toggle.setAttribute('aria-label', '展开候选');
    this.toggle.innerHTML = '<span class="workbench-select-chevron" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="m3.5 6 4.5 4 4.5-4"/></svg></span>';

    this.menu = document.createElement('div');
    this.menu.className = 'workbench-select-menu workbench-combo-menu';
    this.menu.setAttribute('role', 'listbox');
    this.menu.setAttribute('popover', 'manual');
    this.menu.id = `workbench-select-menu-${WorkbenchSelect.sequence += 1}`;

    input.dataset.workbenchList = this.listId;
    input.removeAttribute('list');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', this.menu.id);
    input.autocomplete = 'off';
    input.before(this.wrapper);
    this.wrapper.append(input, this.toggle);
    document.body.append(this.menu);

    // 点击输入框才展开（与原生 datalist 一致）；Tab 经过或浮窗自动聚焦时不弹出，键盘用方向键或直接输入。
    this.onClick = () => { if (!this.opened) this.open(true); };
    this.onInput = () => {
      if (this.committing) return;
      this.open(false);
    };
    this.onKeydown = (event) => this.handleKeydown(event);
    this.onBlur = () => this.close();
    this.onTogglePointerdown = (event) => event.preventDefault();
    this.onToggleClick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (this.opened) return this.close();
      if (document.activeElement !== input) input.focus({ preventScroll: true });
      this.open(true);
    };
    this.onMenuPointerdown = (event) => event.preventDefault();
    this.onMenuClick = (event) => {
      const item = event.target.closest('[data-option-index]');
      if (item) this.commit(Number(item.dataset.optionIndex));
    };
    this.onMutate = () => this.sync();

    input.addEventListener('click', this.onClick);
    input.addEventListener('input', this.onInput);
    input.addEventListener('keydown', this.onKeydown);
    input.addEventListener('blur', this.onBlur);
    this.toggle.addEventListener('pointerdown', this.onTogglePointerdown);
    this.toggle.addEventListener('click', this.onToggleClick);
    this.menu.addEventListener('pointerdown', this.onMenuPointerdown);
    this.menu.addEventListener('click', this.onMenuClick);
    this.observer = new MutationObserver(this.onMutate);
    this.observer.observe(input, { attributes: true, attributeFilter: ['disabled', 'readonly', 'hidden', 'class', 'style'] });
    liveInstances.add(this);
    instances.set(input, this);
    this.sync();
  }

  candidates() {
    const list = document.getElementById(this.listId);
    const values = list ? [...list.querySelectorAll('option')].map((option) => option.value) : [];
    return filterComboValues(values, this.input.value, this.showAll);
  }

  sync() {
    if (!this.input.isConnected) return this.destroy();
    this.wrapper.hidden = this.input.hidden || this.input.classList.contains('hidden') || this.input.style.display === 'none';
    this.toggle.disabled = this.input.disabled || this.input.readOnly;
    if (this.opened) {
      this.values = this.candidates();
      if (!this.values.length) return this.close({ immediate: true });
      this.render();
      this.position();
    }
  }

  render() {
    const current = this.input.value.trim();
    this.menu.replaceChildren(...this.values.map((value, index) => {
      const item = document.createElement('div');
      item.className = 'workbench-select-option';
      item.id = `${this.menu.id}-option-${index}`;
      item.dataset.optionIndex = String(index);
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', String(value === current));
      item.innerHTML = '<span></span><svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3 8 3 3 7-7"/></svg>';
      item.querySelector('span').textContent = value;
      return item;
    }));
    if (this.activeIndex >= this.values.length) this.activeIndex = -1;
    this.paintActive();
  }

  open(showAll = false) {
    if (this.input.disabled || this.input.readOnly) return;
    this.showAll = showAll;
    this.values = this.candidates();
    if (!this.values.length) return this.close({ immediate: true });
    if (!this.opened) this.activeIndex = Math.max(-1, this.values.indexOf(this.input.value.trim()));
    else if (!showAll) this.activeIndex = -1;
    closeOpenSelect(this);
    clearTimeout(this.closeTimer);
    this.render();
    if (this.opened) return this.position();
    this.opened = true;
    openInstance = this;
    this.wrapper.dataset.open = 'true';
    this.input.setAttribute('aria-expanded', 'true');
    this.menu.classList.remove('is-closing');
    this.menu.classList.add('is-opening');
    this.fallbackOpen = false;
    const host = menuHostFor(this.input);
    if (this.menu.parentElement !== host) host.append(this.menu);
    try { this.menu.showPopover(); }
    catch {
      this.fallbackOpen = true;
      this.menu.hidden = false;
    }
    this.position();
    requestAnimationFrame(() => {
      if (!this.opened) return;
      this.menu.classList.remove('is-opening');
      this.menu.classList.add('is-visible');
      this.scrollActiveIntoView();
    });
  }

  close({ immediate = false } = {}) {
    if (!this.opened && !this.menu.classList.contains('is-visible')) return;
    this.opened = false;
    if (openInstance === this) openInstance = null;
    this.wrapper.dataset.open = 'false';
    this.wrapper.dataset.direction = 'down';
    this.input.setAttribute('aria-expanded', 'false');
    this.input.removeAttribute('aria-activedescendant');
    this.menu.classList.remove('is-visible', 'is-opening');
    this.menu.classList.add('is-closing');
    clearTimeout(this.closeTimer);
    const finish = () => {
      this.menu.classList.remove('is-closing');
      if (this.fallbackOpen) {
        this.menu.hidden = true;
        this.fallbackOpen = false;
        return;
      }
      try { if (this.menu.matches(':popover-open')) this.menu.hidePopover(); }
      catch { this.menu.hidden = true; }
    };
    if (immediate || matchMedia('(prefers-reduced-motion: reduce)').matches) finish();
    else this.closeTimer = setTimeout(finish, 150);
  }

  position() {
    if (!this.opened) return;
    const trigger = this.wrapper.getBoundingClientRect();
    if (!trigger.width || !trigger.height) return this.close({ immediate: true });
    this.menu.style.width = `${Math.min(trigger.width, innerWidth - viewportGap * 2)}px`;
    this.menu.style.maxHeight = '320px';
    const desiredHeight = Math.min(Math.max(this.menu.scrollHeight, 44), 320);
    const desiredWidth = Math.max(trigger.width, Math.min(this.menu.scrollWidth, 360));
    const geometry = selectMenuGeometry({ trigger, viewportWidth: innerWidth, viewportHeight: innerHeight, desiredHeight, desiredWidth });
    this.wrapper.dataset.direction = geometry.direction;
    this.menu.dataset.direction = geometry.direction;
    this.menu.style.left = `${geometry.left}px`;
    this.menu.style.top = `${geometry.top}px`;
    this.menu.style.width = `${geometry.width}px`;
    this.menu.style.maxHeight = `${geometry.height}px`;
  }

  move(step) {
    const count = this.values.length;
    if (!count) return;
    this.activeIndex = this.activeIndex < 0 ? (step > 0 ? 0 : count - 1) : (this.activeIndex + step + count) % count;
    this.paintActive();
    this.scrollActiveIntoView();
  }

  paintActive() {
    this.menu.querySelectorAll('[data-option-index]').forEach((item) => {
      item.classList.toggle('is-active', Number(item.dataset.optionIndex) === this.activeIndex);
    });
    if (this.activeIndex >= 0) this.input.setAttribute('aria-activedescendant', `${this.menu.id}-option-${this.activeIndex}`);
    else this.input.removeAttribute('aria-activedescendant');
  }

  scrollActiveIntoView() {
    this.menu.querySelector(`[data-option-index="${this.activeIndex}"]`)?.scrollIntoView({ block: 'nearest' });
  }

  commit(index) {
    const value = this.values[index];
    if (value === undefined) return;
    const changed = this.input.value !== value;
    this.input.value = value;
    if (changed) {
      this.committing = true;
      this.input.dispatchEvent(new Event('input', { bubbles: true }));
      this.input.dispatchEvent(new Event('change', { bubbles: true }));
      this.committing = false;
    }
    this.close();
    if (document.activeElement !== this.input) this.input.focus({ preventScroll: true });
    try { this.input.setSelectionRange(value.length, value.length); } catch {}
  }

  handleKeydown(event) {
    if (event.isComposing) return;
    if (event.key === 'Escape' && this.opened) {
      event.preventDefault();
      event.stopPropagation();
      return this.close();
    }
    if (event.key === 'Tab') return this.close({ immediate: true });
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!this.opened) this.open(true);
      return this.move(event.key === 'ArrowDown' ? 1 : -1);
    }
    // 只有方向键选中了候选时 Enter 才用于确认候选；否则保持输入框的原生行为（如提交表单）。
    if (event.key === 'Enter' && this.opened && this.activeIndex >= 0) {
      event.preventDefault();
      this.commit(this.activeIndex);
    }
  }

  destroy() {
    this.close({ immediate: true });
    this.observer.disconnect();
    liveInstances.delete(this);
    instances.delete(this.input);
    this.menu.remove();
  }
}

function closeOpenSelect(except) {
  if (openInstance && openInstance !== except) openInstance.close({ immediate: true });
}

function enhance(root = document) {
  const selects = root instanceof HTMLSelectElement ? [root] : root.querySelectorAll?.('select') || [];
  for (const select of selects) {
    if (isEligible(select) && !instances.has(select)) new WorkbenchSelect(select);
  }
  const inputs = root instanceof HTMLInputElement ? [root] : root.querySelectorAll?.('input[list]') || [];
  for (const input of inputs) {
    if (isComboEligible(input) && !instances.has(input)) new WorkbenchCombo(input);
  }
}

export function initWorkbenchSelects() {
  enhance(document);
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) enhance(node);
    }
    for (const instance of liveInstances) if (!instance.control.isConnected) instance.destroy();
  });
  observer.observe(document.body, { childList: true, subtree: true });

  document.addEventListener('pointerdown', (event) => {
    if (!openInstance) return;
    if (openInstance.wrapper.contains(event.target) || openInstance.menu.contains(event.target)) return;
    openInstance.close();
  }, true);
  document.addEventListener('click', () => {
    for (const instance of liveInstances) instance.sync();
  });
  document.addEventListener('scroll', (event) => {
    // 菜单自身滚动无需重新定位；重定位会临时放大 max-height，把接近底部的 scrollTop 夹回去。
    if (!openInstance || event.target === openInstance.menu) return;
    openInstance.position();
  }, { capture: true, passive: true });
  window.addEventListener('resize', () => openInstance?.position(), { passive: true });
  window.visualViewport?.addEventListener('resize', () => openInstance?.position(), { passive: true });
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initWorkbenchSelects, { once: true });
  else initWorkbenchSelects();
}
