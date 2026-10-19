export interface OpticalProgressProps {label:string;value?:number;max?:number;completionColor?:'green'|'gold';completeLabel?:string;wave?:boolean;motion?:'system'|'on'|'off';onChange?:(value:number)=>void;onComplete?:(value:number)=>void;}
export interface OpticalProgressHandle {element:HTMLDivElement;readonly value:number;setValue(value:number,options?:{emit?:boolean;animate?:boolean}):void;setCompletionColor(value:'green'|'gold'):void;setMotion(value:'system'|'on'|'off'):void;destroy():void;}
export function createOpticalProgress(props:OpticalProgressProps):OpticalProgressHandle;
