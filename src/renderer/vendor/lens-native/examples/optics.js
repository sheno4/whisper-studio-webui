import {mountShowcase} from '../showcase.js';
const showcaseLanguage=new URLSearchParams(location.search).get('lang')||document.documentElement.dataset.defaultLanguage||'zh';
const showcase=mountShowcase(document.querySelector('#showcase'),{language:showcaseLanguage});
window.addEventListener('pagehide',event=>{if(!event.persisted)showcase.destroy();});
