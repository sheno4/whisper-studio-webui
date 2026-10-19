export interface SliderHandle {element:HTMLLabelElement;readonly value:number;setValue(value:number,options?:{emit?:boolean}):void;destroy():void;}
export function createSlider(options:{label:string;min?:number;max?:number;step?:number;value?:number;onChange?:(value:number)=>void}):SliderHandle;
