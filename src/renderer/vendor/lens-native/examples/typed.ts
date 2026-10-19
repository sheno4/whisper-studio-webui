import {createComponent, createGlassSystem, defineComponent} from '../index.js';
import type {ComponentProps, GlassSystem, CueDefinition} from '../index.js';

// Compile this example in a TypeScript project with the DOM library enabled.
// Use the same two CSS imports as basic.html in your page or bundler.
export function mountSettings(stage: HTMLElement): () => void {
  let system: GlassSystem;
  const focus = createComponent('switch', {
    label: 'Focus',
    onChange: checked => stage.dataset.focus = String(checked),
  });
  const strength = createComponent('slider', {
    label: 'Refraction', value: 90,
    onChange: value => system.setMaterial({refraction: value / 100}),
  });
  stage.append(focus.element, strength.element);
  system = createGlassSystem(stage, {material: 'thick', audio: {volume: .28}});

  const complete: CueDefinition = {duration: .22, tones: [[520, 520, .15], [780, 780, .08, .07]]};
  system.sound.register('complete', complete);
  return () => {
    system.destroy();
    focus.destroy();
    strength.destroy();
  };
}

// Register once, during application setup.
defineComponent('confirm-action', (props: ComponentProps['button']) =>
  createComponent('button', {...props, variant: 'success', sound: 'success'})
);

export function mountCardList(stage: HTMLElement): () => void {
  const progress = createComponent('progress', {label:'Progress', value:42, completionColor:'gold'});
  const slider = createComponent('slider', {label:'Adjust progress', value:42, onChange:value => progress.setValue(value)});
  const cards = createComponent('card-list', {
    label:'My apps',
    autoScroll:24,
    pauseLabel:'Pause cards',
    playLabel:'Play cards',
    items:[{id:'notes', label:'Notes', description:'Capture an idea.'}, {id:'focus', label:'Focus', children:[slider, progress]}],
  });
  stage.append(cards.element);
  const system = createGlassSystem(stage);
  cards.pause();
  if (!cards.playing) cards.play();
  cards.scrollTo('focus', {behavior:'auto'});
  return () => {system.destroy(); cards.destroy();};
}
