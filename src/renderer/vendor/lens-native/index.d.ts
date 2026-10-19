export type MaterialName = 'thick' | 'clear' | 'soft';
export type SceneName = 'aurora' | 'sunset' | 'ocean' | 'grid';
export type OpticalColor = 'green' | 'gold';
export type OpticalMotion = 'system' | 'on' | 'off';
export type OpticalIcon = 'focus' | 'sun' | 'moon' | 'leaf' | 'heart' | 'check' | 'crosshair' | 'plus' | 'wifi' | 'bluetooth' | 'home' | 'layers' | 'adjust' | 'more' | 'reset';
export interface XYValue {x:number;y:number;}
export interface Material { refraction:number; blur:number; dispersion:number; }
export const materialPresets:Readonly<Record<MaterialName,Readonly<Material>>>;
export const tokens:Readonly<{version:string;color:Readonly<Record<string,string>>;type:Readonly<{family:string;body:number;control:number;caption:number}>;space:Readonly<Record<string,number>>;radius:Readonly<Record<string,number>>;surface:Readonly<Record<string,string>>;motion:Readonly<{elasticity:number;spring:string;fast:number;normal:number;feedback:number}>;optics:Readonly<{gold:string;green:string;light:string;flowDuration:number;settleDuration:number;magnification:number}>;audio:Readonly<{enabled:boolean;volume:number;maxVoices:number;cooldown:number;storageKey:string}>;materials:typeof materialPresets}>;
export function resolveMaterial(value?:MaterialName|Partial<Material>):Material;
export type CueName='press'|'grab'|'release'|'select'|'switchOn'|'switchOff'|'tick'|'type'|'success'|'favorite'|'dismiss'|'restore'|'reset';
export interface CueDefinition {duration:number;tones:Array<[fromHz:number,toHz:number,gain:number,delaySeconds?:number]>;noise?:number;cooldown?:number;}
export const soundCues:Readonly<Record<CueName,CueDefinition>>;
export function synthesizeCue(cue:CueName|CueDefinition,sampleRate?:number):Float32Array;
export function synthesizeFriction(sampleRate?:number):Float32Array;
export interface SoundState {enabled:boolean;volume:number;status:'idle'|'ready'|'unavailable';played:number;activeVoices:number;frictionActive:boolean;}
export interface SoundOptions {enabled?:boolean;volume?:number;storageKey?:string;storage?:Pick<Storage,'getItem'|'setItem'>|null;contextFactory?:()=>AudioContext|null;now?:()=>number;onChange?:(state:SoundState)=>void;}
export class GlassSound {
  constructor(options?:SoundOptions);readonly enabled:boolean;readonly volume:number;readonly status:SoundState['status'];
  snapshot():SoundState;set(options:Partial<Pick<SoundState,'enabled'|'volume'>>):void;
  play(name?:CueName|string):Promise<boolean>;register(name:string,definition:CueDefinition):this;stop():void;destroy():void;
  startFriction():Promise<boolean>;updateFriction(speed:number):void;endFriction(immediate?:boolean):void;
}
export function bindControlSounds(root:HTMLElement|Document,sound:GlassSound):()=>void;
/** Shows focus rings after keyboard input; pointer movement, touch and wheel hide them without blurring. Returns cleanup. */
export function bindKeyboardFocus(root?:HTMLElement|Document):()=>void;
export interface ComponentHandle {element:HTMLElement;destroy():void;}
export interface ValueHandle<T> extends ComponentHandle {readonly value:T;setValue(value:T,options?:{emit?:boolean}):void;}
export interface ButtonHandle extends ComponentHandle {setDisabled(value:boolean):void;}
export interface NotificationHandle extends ComponentHandle {show():void;}
/** Child handles are owned and destroyed by the list. Raw nodes remain caller-managed. */
export interface LensCardItem {id:string;label:string;title?:string;description?:string;icon?:Node;children?:Array<ComponentHandle|Node|string>;}
export interface CardListHandle extends ComponentHandle {readonly playing:boolean;scrollTo(id:string,options?:{behavior?:'smooth'|'auto'}):boolean;pause():void;play():void;}
export interface ChoiceOption {value:string;label:string;disabled?:boolean;}
export interface DropOption extends ChoiceOption {icon?:OpticalIcon;}
export interface TabOption extends ChoiceOption {content?:Node|string;}
export interface ToggleHandle extends ValueHandle<boolean> {setDisabled(value:boolean):void;}
export interface MenuHandle extends ComponentHandle {open():void;close():void;}
export const componentCatalog:ReadonlyArray<Readonly<{name:keyof ComponentProps;zh:string;en:string;props:string;kind:'component'}>>;
export interface OpticalProgressHandle extends ComponentHandle {readonly value:number;setValue(value:number,options?:{emit?:boolean;animate?:boolean}):void;setCompletionColor(color:OpticalColor):void;setMotion(motion:OpticalMotion):void;}
export interface DropSelectHandle extends ComponentHandle {readonly value:string;setValue(value:string,options?:{emit?:boolean;animate?:boolean}):boolean;setVariant(variant:'lens'|'capsule'):void;setDisabled(disabled:boolean):void;}
export interface XYSliderHandle extends ValueHandle<XYValue> {setDisabled(disabled:boolean):void;setVariant(variant:'point'|'lens'):void;}
export interface ComponentProps {
  button:{label:string;variant?:'default'|'success';disabled?:boolean;sound?:CueName|string;onPress?:(event:MouseEvent)=>void};
  'icon-button':{label:string;icon?:OpticalIcon;pressed?:boolean;disabled?:boolean;onChange?:(pressed:boolean)=>void;onPress?:(event:MouseEvent)=>void};
  'toggle-tile':{label:string;icon?:OpticalIcon;checked?:boolean;onLabel?:string;offLabel?:string;disabled?:boolean;onChange?:(checked:boolean)=>void};
  tabs:{label:string;options:TabOption[];value?:string;onChange?:(value:string)=>void};
  dock:{label:string;options:DropOption[];value?:string;onChange?:(value:string)=>void};
  menu:{label:string;options:DropOption[];onAction?:(value:string)=>void};
  switch:{label:string;checked?:boolean;onChange?:(checked:boolean)=>void};
  choices:{label:string;options:ChoiceOption[];value?:string;selectionColor?:OpticalColor;onChange?:(value:string,button:HTMLButtonElement)=>void};
  slider:{label:string;min?:number;max?:number;step?:number;value?:number;onChange?:(value:number)=>void};
  stepper:{label:string;min?:number;max?:number;step?:number;value?:number;unit?:string;decreaseLabel?:string;increaseLabel?:string;onChange?:(value:number)=>void};
  notification:{title:string;description?:string;dismissLabel?:string;onDismiss?:()=>void};
  search:{label:string;placeholder?:string;onChange?:(query:string)=>void};
  lens:{label:string;caption?:string};
  panel:{label:string;children?:Array<Node|string>;motion?:'tether'|'press'|'none'};
  'card-list':{label:string;items?:LensCardItem[];previousLabel?:string;nextLabel?:string;emptyLabel?:string;autoScroll?:boolean|number;pauseLabel?:string;playLabel?:string};
  progress:{label:string;value?:number;max?:number;completionColor?:OpticalColor;completeLabel?:string;wave?:boolean;motion?:OpticalMotion;onChange?:(value:number)=>void;onComplete?:(value:number)=>void};
  'drop-select':{label:string;options:DropOption[];value?:string;variant?:'lens'|'capsule';selectionColor?:OpticalColor;disabled?:boolean;dragLabel?:string;onChange?:(value:string)=>void};
  'xy-slider':{label:string;xLabel?:string;yLabel?:string;min?:number;max?:number;step?:number;value?:XYValue;variant?:'point'|'lens';magnification?:number;disabled?:boolean;instruction?:string;onChange?:(value:XYValue)=>void;onCommit?:(value:XYValue)=>void};
}
export interface ComponentHandles {button:ButtonHandle;'icon-button':ToggleHandle;'toggle-tile':ToggleHandle;tabs:ValueHandle<string>;dock:ValueHandle<string>;menu:MenuHandle;switch:ValueHandle<boolean>;choices:ValueHandle<string>;slider:ValueHandle<number>;stepper:ValueHandle<number>;notification:NotificationHandle;search:ValueHandle<string>;lens:ComponentHandle;panel:ComponentHandle;'card-list':CardListHandle;progress:OpticalProgressHandle;'drop-select':DropSelectHandle;'xy-slider':XYSliderHandle;}
export function createComponent<N extends string>(name:N,props:N extends keyof ComponentProps?ComponentProps[N]:Record<string,unknown>):N extends keyof ComponentHandles?ComponentHandles[N]:ComponentHandle;
export function defineComponent<P extends Record<string,unknown>>(name:string,factory:(props:P)=>ComponentHandle):void;
export function listComponents():string[];
export function bindSwitch(element:HTMLButtonElement,options?:{checked?:boolean;onChange?:(value:boolean)=>void}):ValueHandle<boolean>;
export function bindChoiceGroup(element:HTMLElement,options?:{value?:string;selectionColor?:OpticalColor;onChange?:(value:string,button:HTMLButtonElement)=>void}):ValueHandle<string>;
export interface ArtworkInfo {width:number;height:number;dpr:number;scene:SceneName;}
export type ArtworkRenderer = (context:CanvasRenderingContext2D,info:ArtworkInfo)=>void;
export interface RendererOptions extends Partial<Material> {scene?:SceneName;artwork?:ArtworkRenderer;brightness?:number;motion?:boolean;opaque?:boolean;compare?:boolean;onState?:(state:string)=>void;}
export class GlassRenderer {constructor(canvas:HTMLCanvasElement,stage:HTMLElement,options?:RendererOptions);set(options:RendererOptions):void;setScene(scene:SceneName):void;invalidate(duration?:number,geometry?:boolean):void;setMotionSource(source:JellyController):void;destroy():void;}
export class JellyController {constructor(stage:HTMLElement,renderer?:GlassRenderer,options?:{intensity?:number});register(element:HTMLElement,options?:{source?:HTMLElement;mode?:'tether'|'press'|'free'|'range'|'toggle'|'segment';maxTravel?:number;onCommit?:(value:any)=>void;segments?:()=>HTMLElement[];onPosition?:(x:number,y:number)=>void}):unknown;target(element:HTMLElement,x:number,y?:number,options?:{snap?:boolean}):void;pulse(element:HTMLElement,amount?:number):void;setIntensity(value:number,explicit?:boolean):void;reset():void;cancel(snap?:boolean):void;destroy():void;}
export interface GlassSystem {renderer?:GlassRenderer;jelly:JellyController;sound:GlassSound;mount(root?:HTMLElement):this;setMaterial(value:MaterialName|Partial<Material>):void;setScene(value:SceneName):void;destroy():void;}
export function createGlassSystem(stage:HTMLElement,options?:{canvas?:HTMLCanvasElement;material?:MaterialName|Partial<Material>;scene?:SceneName;artwork?:ArtworkRenderer;motion?:boolean;elasticity?:number;audio?:SoundOptions;onFallback?:(error:Error)=>void}):GlassSystem;
