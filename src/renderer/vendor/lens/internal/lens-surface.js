/** Shared lens component body. The stage supplies one renderer and spring controller. */
export function createLensSurface({element,tag = 'div', className = '', kind = 'panel', motion = 'none',dragHandle} = {}) {
  element ||= document.createElement(tag);
  const addedClasses=['lg-surface',...className.split(/\s+/).filter(Boolean)].filter(value=>!element.classList.contains(value));
  const attributes=['data-glass','data-lg-lens','data-lg-drag','data-lg-drag-handle'];
  const previous=attributes.map(name=>element.getAttribute(name));
  element.classList.add('lg-surface');for(const value of className.split(/\s+/).filter(Boolean))element.classList.add(value);
  element.dataset.glass = kind;
  element.dataset.lgLens = kind;
  if (motion !== 'none') element.dataset.lgDrag = motion;else delete element.dataset.lgDrag;
  if(dragHandle)element.dataset.lgDragHandle=dragHandle;else delete element.dataset.lgDragHandle;
  return {element, destroy() {
    attributes.forEach((name,index)=>{if(previous[index]===null)element.removeAttribute(name);else element.setAttribute(name,previous[index]);});
    for(const value of addedClasses)element.classList.remove(value);
  }};
}
