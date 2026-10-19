import {createComponent} from './components.js';
import {createGlassSystem} from './runtime.js';
import {opticalIcon} from './optical-components.js';
import {labelComponentSample} from './component-catalog.js';

const opticalDemoCopy = {
  zh: {
    title: '让光，回应每一次操作', intro: '进度、落点与二维调节。保留玻璃的通透，让反馈沿着光线发生。',
    scene: '背景', aurora: '流光', ocean: '深海', grid: '光学网格',
    progressTitle: '光导进度', progressIntro: '光纤在已完成区内轻轻波动；完成时，流光带出新的颜色。', progress: '当前进度', complete: '已完成', progressAdjust: '调整进度', add: '推进 25%', finish: '完成', reset: '重置', completion: '完成颜色', green: '绿色', gold: '金色', motion: '动效', system: '跟随系统', on: '播放波动', off: '静止',
    dropTitle: '凹槽吸附选择', dropIntro: '松手后吸附最近的凹槽，透明玻璃顺势汇入，落点随之隆起并泛出绿色反光。', drop: '拖放选择', drag: '松手吸附最近凹槽。点击和方向键也会沿途流入。', shape: '拖动形态', lens: '透镜', capsule: '胶囊',
    xyTitle: '二维调节', xyIntro: '在色域中游移，用放大透镜看清细微的变化。', xy: '色彩调节', warmth: '色温', tone: '色调', xyHint: '拖动或使用方向键；Shift 加速，Home 复位。', pointer: '普通触点', magnifier: '放大透镜 · 1.8×', control: '选择方式',
    choiceTitle: '选中，留下一道光', choiceIntro: '边缘由冷光转为金色，流转一周后安静停驻。', choices: '场景选项', selected: '当前选择', focus: '专注', daylight: '日光', evening: '晚间', choiceHint: '点击胶囊，或用方向键切换。',
  },
  en: {
    title: 'Light follows your intention.', intro: 'Progress, a place to land, and two dimensions to explore. Clear glass, with feedback carried by light.',
    scene: 'Scene', aurora: 'Aurora', ocean: 'Ocean', grid: 'Optical grid',
    progressTitle: 'Light-guided progress', progressIntro: 'Light gently ripples through the completed portion. A travelling highlight carries the completion color.', progress: 'Progress', complete: 'Complete', progressAdjust: 'Adjust progress', add: 'Advance 25%', finish: 'Complete', reset: 'Reset', completion: 'Completion color', green: 'Green', gold: 'Gold', motion: 'Motion', system: 'System setting', on: 'Play waves', off: 'Still',
    dropTitle: 'Magnetic well selection', dropIntro: 'Release near a well. Clear glass glides to the nearest one and flows into a raised green reflection.', drop: 'Drop selection', drag: 'Release to snap to the nearest well. Click or use arrow keys for the same flowing transition.', shape: 'Drag with', lens: 'Lens', capsule: 'Capsule',
    xyTitle: 'Two dimensions of control', xyIntro: 'Move through the color field. Use the magnifying lens to see the finer changes.', xy: 'Color adjustment', warmth: 'Warmth', tone: 'Tone', xyHint: 'Drag or use arrow keys. Shift moves faster; Home resets.', pointer: 'Point', magnifier: 'Magnifying lens · 1.8×', control: 'Select with',
    choiceTitle: 'A choice, traced in light.', choiceIntro: 'The rim turns from cool light to gold, travels once, then settles.', choices: 'Scene choices', selected: 'Selected', focus: 'Focus', daylight: 'Daylight', evening: 'Evening', choiceHint: 'Click a capsule, or change it with the arrow keys.',
  },
};
const opticalDemoNode = (tag, className, text) => {const element = document.createElement(tag); element.className = className; if (text !== undefined) element.textContent = text; return element;};
let opticalDemoId = 0;

/** Shared by the catalog, the material lab and the standalone bilingual example. */
export function mountOpticalDemo(host, {language = 'zh', initialState = {}} = {}) {
  let lang = language === 'en' ? 'en' : 'zh', systems = [], handles = [], abort;
  const state = {scene: 'aurora', progress: 38, completion: 'green', progressMotion: 'system', drop: 'focus', shape: 'lens', xy: {x: 0, y: 0}, xyVariant: 'lens', choice: 'focus', ...initialState};
  const dispose = () => {abort?.abort(); systems.forEach(system => system.destroy()); handles.forEach(handle => handle.destroy()); systems = []; handles = [];};
  function render() {
    dispose(); host.replaceChildren(); abort = new AbortController(); const signal = abort.signal, c = opticalDemoCopy[lang];
    host.classList.add('optical-demo'); host.lang = lang === 'zh' ? 'zh-CN' : 'en';
    const title = opticalDemoNode('h2', 'od-title', c.title), intro = opticalDemoNode('p', 'od-intro', c.intro), toolbar = opticalDemoNode('div', 'od-toolbar'), grid = opticalDemoNode('div', 'od-grid');
    title.id = `od-title-${++opticalDemoId}`; host.setAttribute('aria-labelledby', title.id); host.append(title, intro, toolbar, grid);
    const select = (parent, label, entries, value, onChange) => {
      const wrapper = opticalDemoNode('label', 'od-select'), control = opticalDemoNode('select', '');
      wrapper.append(opticalDemoNode('span', '', label), control);
      for (const [key, text] of entries) {const option = opticalDemoNode('option', '', text); option.value = key; control.append(option);}
      control.value = value; control.addEventListener('change', () => onChange(control.value), {signal}); parent.append(wrapper); return control;
    };
    select(toolbar, c.scene, ['aurora', 'ocean', 'grid'].map(key => [key, c[key]]), state.scene, value => {state.scene = value; systems.forEach(system => system.setScene(value));});
    const sample = (key, extraClass = '') => {
      const section = opticalDemoNode('section', 'od-sample'), stage = opticalDemoNode('div', `od-stage ${extraClass}`), controls = opticalDemoNode('div', 'od-controls');
      section.append(opticalDemoNode('h3', '', c[`${key}Title`]), opticalDemoNode('p', 'od-description', c[`${key}Intro`]), controls, stage); grid.append(section);
      labelComponentSample(section,{progress:'progress',drop:'drop-select',xy:'xy-slider',choice:'choices'}[key],lang);
      return {stage, controls};
    };
    const mount = (name, props, parent) => {const handle = createComponent(name, props); parent.append(handle.element); handles.push(handle); return handle;};
    const progressSample = sample('progress', 'od-progress-stage');
    const progress = mount('progress', {label: c.progress, value: state.progress, completionColor: state.completion, completeLabel: c.complete, motion: state.progressMotion, onChange: value => {state.progress = value; progressInput.value = value; completeButton.disabled = value === 100;}}, progressSample.stage);
    select(progressSample.controls, c.completion, [['green', c.green], ['gold', c.gold]], state.completion, value => {state.completion = value; progress.setCompletionColor(value);});
    select(progressSample.controls, c.motion, ['system','on','off'].map(key=>[key,c[key]]), state.progressMotion, value => {state.progressMotion=value;progress.setMotion(value);});
    const progressLabel = opticalDemoNode('label', 'od-progress-input'), progressInput = opticalDemoNode('input', ''); progressInput.type = 'range'; progressInput.min = 0; progressInput.max = 100; progressInput.value = state.progress;
    progressLabel.append(opticalDemoNode('span', '', c.progressAdjust), progressInput); progressSample.stage.append(progressLabel);
    const actions = opticalDemoNode('div', 'od-actions'); progressSample.stage.append(actions);
    const action = (label, handler) => {const button = opticalDemoNode('button', 'od-action', label); button.type = 'button'; button.addEventListener('click', handler, {signal}); actions.append(button); return button;};
    const setProgress = value => progress.setValue(value, {emit: true});
    action(c.add, () => setProgress(Math.min(100, progress.value + 25)));
    const completeButton = action(c.finish, () => setProgress(100)); completeButton.disabled = state.progress === 100;
    action(c.reset, () => setProgress(0)); progressInput.addEventListener('input', () => setProgress(Number(progressInput.value)), {signal});

    const options = [{value: 'focus', label: c.focus, icon: 'focus'}, {value: 'daylight', label: c.daylight, icon: 'sun'}, {value: 'evening', label: c.evening, icon: 'moon'}];
    const dropSample = sample('drop', 'od-drop-stage');
    const drop = mount('drop-select', {label: c.drop, options, value: state.drop, variant: state.shape, dragLabel: c.drag, onChange: value => {state.drop = value;}}, dropSample.stage);
    select(dropSample.controls, c.shape, [['lens', c.lens], ['capsule', c.capsule]], state.shape, value => {state.shape = value;drop.setVariant(value);});

    const xySample = sample('xy', 'od-xy-stage');
    const xy = mount('xy-slider', {label: c.xy, xLabel: c.warmth, yLabel: c.tone, value: state.xy, variant: state.xyVariant, instruction: c.xyHint, onChange: value => {state.xy = value;}}, xySample.stage);
    select(xySample.controls, c.control, [['point', c.pointer], ['lens', c.magnifier]], state.xyVariant, value => {state.xyVariant = value; xy.setVariant(value);});

    const choiceSample = sample('choice', 'od-choice-stage'), emblem = opticalDemoNode('div', 'od-choice-emblem'), choiceOutput = opticalDemoNode('output', 'od-choice-output');
    const showChoice = value => {const selected = options.find(option => option.value === value); emblem.replaceChildren(opticalIcon(selected.icon)); choiceOutput.value = `${c.selected} · ${selected.label}`;};
    choiceSample.stage.append(emblem, choiceOutput); showChoice(state.choice); choiceOutput.setAttribute('aria-live', 'polite');
    mount('choices', {label: c.choices, value: state.choice, options, selectionColor: 'gold', onChange: value => {state.choice = value; showChoice(value);}}, choiceSample.stage);
    choiceSample.stage.append(opticalDemoNode('p', 'od-choice-hint', c.choiceHint));
    for (const stage of [progressSample.stage, dropSample.stage, xySample.stage, choiceSample.stage]) systems.push(createGlassSystem(stage, {scene: state.scene, motion: false, audio: {enabled: false, storage: null}}));
  }
  render();
  return {setLanguage(next) {const nextLanguage = next === 'en' ? 'en' : 'zh'; if (nextLanguage !== lang) {lang = nextLanguage; render();}}, destroy() {dispose(); host.replaceChildren();}, snapshot() {return {...state, xy: {...state.xy}};}};
}
