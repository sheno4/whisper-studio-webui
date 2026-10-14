import type {JellyController} from './index';
export interface MotionSystem {jelly:JellyController;mount(root?:HTMLElement):this;destroy():void;}
export function createMotionSystem(stage:HTMLElement):MotionSystem;
