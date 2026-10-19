import {showcaseCategories,showcaseView,showcaseLinePoints,showcaseRingPath} from './internal/showcase-data.js';
import {ChartGlass} from './internal/chart-glass.js';
import {RecordsGlass} from './internal/records-glass.js';
import {createComponent} from './components.js';
import {labelComponentSample} from './component-catalog.js';
import {addOpticalRim} from './optical-components.js';
import {setOpticalState,clearOpticalState,opticalSelection} from './internal/optics.js';

const vizNode=(tag,className,text)=>{const element=document.createElement(tag);element.className=className;if(text!==undefined)element.textContent=text;return element;};
const vizSvg=(tag,attributes={})=>{const element=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value] of Object.entries(attributes))element.setAttribute(key,String(value));return element;};
let vizInstance=0;

export function mountShowcaseCharts(host,{language='zh',initialState={}}={}){
  const en=language==='en',c=en?{
    title:'Data, in a different light.',intro:'Follow a curve, compare a column, find your rhythm. These charts share one illustrative dataset.',sample:'Illustrative data · Sep 5–18, 2026',week:'7 days',fortnight:'14 days',trend:'A little time, every day.',trendHint:'Move over the curve, or use the slider to inspect a day.',browse:'Inspect daily focus time',minutes:'min',hours:'h',bar:'Where time takes shape.',barHint:'Select a category to explore it across the charts and table.',ring:'Time, in pieces.',ringHint:'The whole stays visible. Your selection comes into focus.',all:'All activities',clear:'Clear filter',data:'Read the chart data',date:'Date',activity:'Activity',duration:'Duration',state:'Progress',records:'The details, kept clear.',tableIntro:'Search, sort, or select a record. Glass leaves room for the information.',search:'Search records',placeholder:'Search an activity or date',empty:'No matching records.',reset:'Clear search and filter',previous:'Previous',next:'Next',inspect:'View record',ready:'Complete',running:'In progress',selected:'Selected record',choose:'Select a row to see its details.',page:'Records',of:'of',filter:'Showing',sort:'Sort by',category:'Category',
  }:{
    title:'让数据，也透一口气。',intro:'沿着曲线读趋势，让柱形承接分量，用圆环看见全貌。图表与表格共用同一组示例数据。',sample:'示例数据 · 2026 年 9 月 5–18 日',week:'近 7 天',fortnight:'近 14 天',trend:'一天里的专注节律。',trendHint:'沿曲线移动，或使用滑杆查看每一天。',browse:'浏览每日专注时长',minutes:'分钟',hours:'小时',bar:'时间，落在了哪里。',barHint:'选择一个分类，联动查看曲线与下方记录。',ring:'把时间，轻轻展开。',ringHint:'全貌始终可见，所选部分浮现于光中。',all:'全部活动',clear:'清除筛选',data:'查看图表数据',date:'日期',activity:'活动',duration:'时长',state:'进度',records:'细节，也可以清晰轻盈。',tableIntro:'搜索、排序或选择一条记录，让玻璃为信息留出空间。',search:'搜索记录',placeholder:'搜索活动名称或日期',empty:'没有匹配的记录。',reset:'清除搜索和筛选',previous:'上一页',next:'下一页',inspect:'查看记录',ready:'已完成',running:'进行中',selected:'已选记录',choose:'选择一条记录，查看它的细节。',page:'记录',of:'共',filter:'正在显示',sort:'按此列排序',category:'分类',
  };
  const state={days:7,category:'all',query:'',sort:'date',direction:'desc',page:0,day:6,record:null,...initialState};
  const abort=new AbortController(),signal=abort.signal,id=++vizInstance;
  const time=value=>en?`${Math.floor(value/60)}h ${value%60}m`:`${Math.floor(value/60)}小时 ${value%60}分`;
  const shortDate=date=>en?`Sep ${Number(date.slice(-2))}`:`9 月 ${Number(date.slice(-2))} 日`;
  const categoryLabel=key=>{const category=showcaseCategories.find(item=>item.id===key);return category?(en?category.en:category.zh):c.all;};
  const heading=vizNode('div','sc-section-heading'),headingCopy=vizNode('div','');headingCopy.append(vizNode('h2','',c.title),vizNode('p','sc-intro',c.intro));heading.append(headingCopy);host.append(heading);
  const toolbar=vizNode('div','viz-toolbar'),range=vizNode('div','sc-segment'),periodButtons=[];range.setAttribute('role','group');range.setAttribute('aria-label',en?'Chart period':'图表周期');
  for(const days of [7,14]){const button=vizNode('button','',days===7?c.week:c.fortnight);button.type='button';button.addEventListener('click',()=>{state.days=days;state.day=days-1;state.page=0;update();},{signal});range.append(button);periodButtons.push({button,days});}
  const filter=vizNode('button','viz-filter'),sample=vizNode('p','viz-sample',c.sample);filter.type='button';filter.addEventListener('click',()=>{state.category='all';state.page=0;update();},{signal});toolbar.append(range,filter,sample);host.append(toolbar);
  const grid=vizNode('div','viz-grid'),trend=vizNode('article','viz-panel viz-trend'),bar=vizNode('article','viz-panel viz-bars'),ring=vizNode('article','viz-panel viz-ring');
  grid.append(trend,ring,bar);host.append(grid);
  trend.append(vizNode('h3','',c.trend));const reading=vizNode('output','viz-reading');reading.setAttribute('aria-live','polite');trend.append(reading);
  const chart=vizSvg('svg',{viewBox:'0 0 640 230',role:'img','aria-label':en?'Daily focus duration in minutes':'每日专注时长，单位分钟',class:'viz-line'});
  const definitions=vizSvg('defs'),gradient=vizSvg('linearGradient',{id:`viz-area-${id}`,x1:0,y1:0,x2:0,y2:1});gradient.append(vizSvg('stop',{offset:0,'stop-color':'#7fb7aa','stop-opacity':.42}),vizSvg('stop',{offset:1,'stop-color':'#7fb7aa','stop-opacity':0}));definitions.append(gradient);chart.append(definitions);
  const rules=vizSvg('g',{class:'viz-rules'}),area=vizSvg('path',{fill:`url(#viz-area-${id})`}),line=vizSvg('path',{fill:'none',stroke:'#357e75','stroke-width':3,'stroke-linejoin':'round','stroke-linecap':'round'}),guide=vizSvg('line',{stroke:'#648b83','stroke-dasharray':'4 5',y1:20,y2:204}),point=vizSvg('circle',{r:6,fill:'#f7fffb',stroke:'#357e75','stroke-width':3});
  for(const item of [area,line,point])item.classList.add('viz-chart-ink');
  chart.dataset.lgFriction='true';
  const plotSurface=vizNode('div','viz-line-wrap');chart.append(rules,area,line,guide,point);plotSurface.append(chart);trend.append(plotSurface);const dates=vizNode('div','viz-dates'),firstDate=vizNode('span',''),lastDate=vizNode('span','');dates.append(firstDate,lastDate);trend.append(dates);
  const scrub=vizNode('input','viz-scrub');scrub.type='range';scrub.min=0;scrub.step=1;scrub.setAttribute('aria-label',c.browse);scrub.addEventListener('input',()=>{state.day=Number(scrub.value);selectDay();},{signal});trend.append(scrub,vizNode('p','viz-hint',c.trendHint));
  chart.addEventListener('pointermove',event=>{const rect=chart.getBoundingClientRect(),x=(event.clientX-rect.left)/rect.width*640;state.day=Math.max(0,Math.min(view.daily.length-1,Math.round((x-32)/576*(view.daily.length-1))));selectDay();},{signal,passive:true});
  chart.addEventListener('pointerdown',event=>{const rect=chart.getBoundingClientRect();state.day=Math.max(0,Math.min(view.daily.length-1,Math.round(((event.clientX-rect.left)/rect.width*640-32)/576*(view.daily.length-1))));selectDay();},{signal,passive:true});
  ring.append(vizNode('h3','',c.ring));const wheelWrap=vizNode('div','viz-wheel-wrap'),wheel=vizSvg('svg',{viewBox:'0 0 240 240',role:'img','aria-label':en?'Category share of total duration':'各分类占总时长的比例'}),wheelCenter=vizNode('div','viz-wheel-center'),totalValue=vizNode('strong',''),totalLabel=vizNode('span','',c.minutes);wheelCenter.append(totalValue,totalLabel);wheelWrap.append(wheel,wheelCenter);ring.append(wheelWrap);
  const legends=vizNode('div','viz-legend'),categoryButtons=[],bars=[];ring.append(legends,vizNode('p','viz-hint',c.ringHint));bar.append(vizNode('h3','',c.bar),vizNode('p','viz-hint',c.barHint));const barRows=vizNode('div','viz-bar-rows');bar.append(barRows);
  const chooseCategory=key=>{state.category=state.category===key?'all':key;state.page=0;update();};
  for(const category of showcaseCategories){
    const button=vizNode('button','viz-legend-button'),dot=vizNode('span','viz-dot'),label=vizNode('span','',categoryLabel(category.id)),value=vizNode('strong','');button.type='button';dot.style.background=category.color;button.append(dot,label,value);button.addEventListener('click',()=>chooseCategory(category.id),{signal});legends.append(button);categoryButtons.push({button,value,category});
    const row=vizNode('button','viz-bar-button'),name=vizNode('span','',categoryLabel(category.id)),track=vizNode('span','viz-bar-track'),fill=vizNode('span','viz-bar-fill'),number=vizNode('strong','');row.type='button';fill.style.setProperty('--bar-color',category.color);track.append(fill);row.append(name,track,number);row.addEventListener('click',()=>chooseCategory(category.id),{signal});barRows.append(row);bars.push({row,fill,number,category});
  }
  const dataDetails=vizNode('details','viz-data'),dataSummary=vizNode('summary','',c.data),dataTable=vizNode('table','');dataDetails.append(dataSummary,dataTable);host.append(dataDetails);
  const tableSection=vizNode('section','viz-table-section');tableSection.id='records';tableSection.append(vizNode('h2','',c.records),vizNode('p','sc-intro',c.tableIntro));host.append(tableSection);
  const board=vizNode('div','viz-records-board lg-stage'),canvas=vizNode('canvas','lg-canvas');canvas.setAttribute('aria-hidden','true');board.append(canvas);tableSection.append(board);
  const tools=vizNode('div','viz-table-tools'),searchSample=vizNode('section','viz-search-sample'),searchField=vizNode('div','viz-search-field');
  const searchControl=createComponent('search',{label:c.search,placeholder:c.placeholder,onChange:value=>{state.query=value;state.page=0;updateTable();}});
  const searchLabel=searchControl.element,search=searchLabel.querySelector('input');searchLabel.classList.add('viz-search');searchControl.setValue(state.query);
  const searchIcon=vizSvg('svg',{viewBox:'0 0 24 24',class:'viz-search-icon','aria-hidden':'true'});searchIcon.append(vizSvg('circle',{cx:10.5,cy:10.5,r:6.5}),vizSvg('path',{d:'m15.5 15.5 5 5'}));searchLabel.prepend(searchIcon);
  const clearSearch=vizNode('button','viz-search-clear');clearSearch.type='button';clearSearch.setAttribute('aria-label',en?'Clear search':'清空搜索');clearSearch.dataset.lgSound='dismiss';
  const clearIcon=vizSvg('svg',{viewBox:'0 0 24 24','aria-hidden':'true'});clearIcon.append(vizSvg('path',{d:'m7 7 10 10M17 7 7 17'}));clearSearch.append(clearIcon);
  const clearQuery=()=>{state.query='';state.page=0;searchControl.setValue('');updateTable();search.focus();};
  clearSearch.addEventListener('click',clearQuery,{signal});search.addEventListener('keydown',event=>{if(event.key==='Escape'&&search.value){event.preventDefault();clearQuery();}},{signal});
  search.addEventListener('focus',()=>{searchLabel.style.setProperty('--glass-selection','.45');opticalSelection(searchLabel,true,'green',false);},{signal});
  search.addEventListener('blur',()=>{searchLabel.style.setProperty('--glass-selection','0');opticalSelection(searchLabel,false,'green',false);},{signal});
  searchField.append(searchLabel,clearSearch);
  const rowCount=vizNode('output','viz-row-count');rowCount.setAttribute('aria-live','polite');
  const sortLabel=vizNode('label','viz-sort-control'),sortSelect=vizNode('select','');sortLabel.append(vizNode('span','',en?'Sort':'排序'),sortSelect);sortSelect.setAttribute('aria-label',en?'Sort records':'记录排序');
  for(const [key,label] of [['date',c.date],['minutes',c.duration],['progress',c.state]])for(const direction of ['desc','asc']){const option=vizNode('option','',`${label} · ${en?(direction==='desc'?'descending':'ascending'):(direction==='desc'?'降序':'升序')}`);option.value=`${key}:${direction}`;sortSelect.append(option);}
  sortSelect.addEventListener('change',()=>{[state.sort,state.direction]=sortSelect.value.split(':');state.page=0;updateTable();},{signal});
  searchSample.append(searchField);labelComponentSample(searchSample,'search',language);tools.append(searchSample,rowCount,sortLabel);board.append(tools);
  for(const [sample,name] of [[trend,'line-chart'],[bar,'bar-chart'],[ring,'ring-chart'],[tableSection,'records-table']])labelComponentSample(sample,name,language);
  const tableWrap=vizNode('div','viz-table-scroll');tableWrap.setAttribute('role','region');tableWrap.setAttribute('aria-label',en?'Activity records':'活动记录');const table=vizNode('table','viz-table'),caption=vizNode('caption','lg-visually-hidden',c.sample),thead=vizNode('thead',''),headerRow=vizNode('tr',''),sortHeaders=[];table.setAttribute('role','table');table.append(caption,thead);thead.append(headerRow);
  for(const [key,label] of [['title',c.activity],['date',c.date],['minutes',c.duration],['progress',c.state],['action',c.inspect]]){
    const th=vizNode('th','');th.scope='col';if(['date','minutes','progress'].includes(key)){const button=vizNode('button','',label);button.type='button';button.setAttribute('aria-label',`${label} · ${c.sort}`);button.addEventListener('click',()=>{state.direction=state.sort===key&&state.direction==='desc'?'asc':'desc';state.sort=key;state.page=0;updateTable();},{signal});th.append(button);sortHeaders.push({th,button,key,label});}else th.textContent=label;headerRow.append(th);
  }
  const compactTable=matchMedia('(max-width:600px)'),syncSortFocus=()=>{for(const item of sortHeaders)item.button.tabIndex=compactTable.matches?-1:0;};syncSortFocus();compactTable.addEventListener('change',syncSortFocus,{signal});
  const tbody=vizNode('tbody','');table.append(tbody);tableWrap.append(table);board.append(tableWrap);
  const empty=vizNode('div','viz-empty'),reset=vizNode('button','sc-quiet-button',c.reset);reset.type='button';reset.addEventListener('click',()=>{state.query='';state.category='all';state.page=0;searchControl.setValue('');update();search.focus();},{signal});empty.append(vizNode('p','',c.empty),reset);board.append(empty);
  const paging=vizNode('div','viz-pagination'),previous=vizNode('button','sc-quiet-button',c.previous),next=vizNode('button','sc-quiet-button',c.next),pageText=vizNode('span','');previous.type=next.type='button';previous.addEventListener('click',()=>{state.page--;updateTable();},{signal});next.addEventListener('click',()=>{state.page++;updateTable();},{signal});paging.append(previous,pageText,next);board.append(paging);
  const insight=vizNode('output','viz-insight',c.choose);insight.setAttribute('aria-live','polite');board.append(insight);
  let recordsGlass;try{recordsGlass=new RecordsGlass(canvas,board);}catch{canvas.remove();board.classList.add('fallback');}
  let rowHandles=[];
  const lineGlass=new ChartGlass(plotSurface,{kind:'line'}),ringGlass=new ChartGlass(wheelWrap,{kind:'ring'}),barGlass=new ChartGlass(barRows,{kind:'bars',measure:()=>{
    const origin=barRows.getBoundingClientRect();return bars.map(({row})=>{const rect=row.querySelector('.viz-bar-track').getBoundingClientRect();return [rect.left-origin.left,rect.top-origin.top,rect.width,rect.height];});
  }});
  let view,points,painted=false;
  function selectDay(){
    state.day=Math.max(0,Math.min(view.daily.length-1,state.day));const selected=points[state.day];scrub.max=view.daily.length-1;scrub.value=state.day;scrub.setAttribute('aria-valuetext',`${shortDate(selected.date)} · ${time(selected.minutes)}`);reading.textContent=`${shortDate(selected.date)} / ${time(selected.minutes)}`;
    point.setAttribute('cx',selected.x);point.setAttribute('cy',selected.y);guide.setAttribute('x1',selected.x);guide.setAttribute('x2',selected.x);guide.setAttribute('y1',Math.min(204,selected.y+24));lineGlass.set({lens:selected});
  }
  function updateTable(){
    const data=showcaseView(state),pages=Math.max(1,Math.ceil(data.rows.length/8));state.page=Math.max(0,Math.min(pages-1,state.page));disposeRows();tbody.replaceChildren();
    for(const row of data.rows.slice(state.page*8,state.page*8+8)){
      const tr=vizNode('tr','viz-record'),title=vizNode('td','viz-record-title'),text=vizNode('span','viz-record-copy'),name=vizNode('strong','',en?row.titleEn:row.titleZh),category=vizNode('span','viz-record-category',categoryLabel(row.category));tr.setAttribute('role','row');text.append(name,category);
      const surface=vizNode('div','viz-row-glass lg-surface');surface.dataset.glass='optical-well';surface.setAttribute('aria-hidden','true');addOpticalRim(surface);setOpticalState(surface,{kind:2,selected:0},{animate:false});
      const symbol=vizNode('span','viz-record-symbol'),icon=vizSvg('svg',{viewBox:'0 0 24 24','aria-hidden':'true'}),paths={design:'m4 16 11-11 4 4-11 11-5 1 1-5Zm8-8 4 4',reading:'M12 6v14M3 4c4-1 7 0 9 2 2-2 5-3 9-2v14c-4-1-7 0-9 2-2-2-5-3-9-2V4Z',building:'m12 3 9 5v9l-9 5-9-5V8l9-5Zm-9 5 9 5 9-5m-9 5v9',planning:'M8 6h12M8 12h12M8 18h12M3 6h1M3 12h1M3 18h1'};icon.append(vizSvg('path',{d:paths[row.category]}));symbol.append(icon);symbol.style.setProperty('--record-color',showcaseCategories.find(item=>item.id===row.category).color);title.append(surface,symbol,text);
      const progressCell=vizNode('td','viz-progress-cell'),progress=createComponent('progress',{label:`${en?row.titleEn:row.titleZh} ${c.state}`,value:row.progress,completeLabel:c.ready,wave:false});progress.element.classList.add('viz-cell-progress');progress.element.querySelector('.lg-progress-heading').setAttribute('aria-hidden','true');progress.element.querySelector('[role=status]').setAttribute('aria-hidden','true');const progressLabel=vizNode('span','viz-progress-label',row.progress===100?c.ready:`${row.progress}%`);progressLabel.setAttribute('aria-hidden','true');progressCell.dataset.label=c.state;progressCell.append(progress.element,progressLabel);
      const action=vizNode('td','viz-record-action'),control=createComponent('button',{label:en?'View':'查看',onPress:()=>{state.record=row.id;paintSelection(true);insight.textContent=describeRow(row);}}),button=control.element;button.classList.add('viz-row-select');button.removeAttribute('data-lg-drag');button.setAttribute('aria-label',`${c.inspect} · ${en?row.titleEn:row.titleZh} · ${shortDate(row.date)}`);button.textContent='';
      const buttonText=vizNode('span','',en?'View':'查看'),buttonIcon=vizSvg('svg',{viewBox:'0 0 24 24','aria-hidden':'true'});buttonIcon.append(vizSvg('path',{d:'M5 12h14m-6-6 6 6-6 6'}));button.append(buttonText,buttonIcon);addOpticalRim(button);action.append(button);
      const date=vizNode('td','viz-record-date',shortDate(row.date)),duration=vizNode('td','viz-numeric',`${row.minutes} ${c.minutes}`);duration.dataset.label=c.duration;tr.append(title,date,duration,progressCell,action);for(const cell of tr.children)cell.setAttribute('role','cell');tbody.append(tr);rowHandles.push({row,tr,surface,progress,control,button,buttonText,buttonIcon});
    }
    for(const item of sortHeaders){item.th.setAttribute('aria-sort',state.sort===item.key?(state.direction==='asc'?'ascending':'descending'):'none');item.button.textContent=item.label+(state.sort===item.key?(state.direction==='asc'?' ↑':' ↓'):'');}
    sortSelect.value=`${state.sort}:${state.direction}`;clearSearch.hidden=!state.query;
    rowCount.textContent=en?`${data.rows.length} ${data.rows.length===1?'record':'records'}`:`${data.rows.length} 条记录`;empty.hidden=data.rows.length>0;tableWrap.hidden=data.rows.length===0;paging.hidden=data.rows.length===0;previous.disabled=state.page===0;next.disabled=state.page>=pages-1;pageText.textContent=`${state.page*8+1}–${Math.min(data.rows.length,(state.page+1)*8)} / ${data.rows.length}`;
    const selected=data.rows.find(row=>row.id===state.record);
    if(!selected)state.record=null;
    insight.textContent=selected?describeRow(selected):c.choose;paintSelection(false);recordsGlass?.invalidate(150);
  }
  function describeRow(row){return `${c.selected}：${en?row.titleEn:row.titleZh} · ${shortDate(row.date)} · ${time(row.minutes)} · ${row.progress===100?c.ready:c.running}`;}
  function paintSelection(animate){
    for(const item of rowHandles){const selected=state.record===item.row.id;item.tr.dataset.selected=String(selected);item.button.setAttribute('aria-pressed',String(selected));item.buttonText.textContent=selected?(en?'Selected':'已选'):(en?'View':'查看');item.buttonIcon.querySelector('path').setAttribute('d',selected?'m5 12 4 4L19 6':'M5 12h14m-6-6 6 6-6 6');for(const element of [item.surface,item.button,item.progress.element.querySelector('.lg-progress-track')])opticalSelection(element,selected,'green',animate);}
  }
  function disposeRows(){for(const item of rowHandles){item.progress.destroy();item.control.destroy();for(const element of [item.surface,item.button]){element.getAnimations({subtree:true}).forEach(animation=>animation.cancel());clearOpticalState(element);}}rowHandles=[];}
  function update(){
    view=showcaseView(state);for(const item of periodButtons)item.button.setAttribute('aria-pressed',String(item.days===state.days));filter.hidden=state.category==='all';filter.textContent=`${c.filter}：${categoryLabel(state.category)} · ${c.clear}`;
    const plot=showcaseLinePoints(view.daily);points=plot.points;line.setAttribute('d',points.map((p,index)=>`${index?'L':'M'}${p.x},${p.y}`).join(' '));area.setAttribute('d',`${line.getAttribute('d')} L608,204 L32,204 Z`);rules.replaceChildren();
    for(let i=0;i<4;i++){const y=204-i*178/3;rules.append(vizSvg('line',{x1:32,x2:608,y1:y,y2:y,stroke:'#d9e3e1','stroke-width':1}));const label=vizSvg('text',{x:0,y:y+4,fill:'#657570','font-size':11});label.textContent=String(Math.round(plot.max*i/3));rules.append(label);}
    firstDate.textContent=shortDate(view.dates[0]);lastDate.textContent=shortDate(view.dates.at(-1));selectDay();
    const total=view.totals.reduce((sum,item)=>sum+item.minutes,0),maximum=Math.max(...view.totals.map(item=>item.minutes));
    const ringDefinitions=vizSvg('defs');wheel.replaceChildren(ringDefinitions);let angle=0;
    for(const item of categoryButtons){const entry=view.totals.find(value=>value.id===item.category.id),share=entry.minutes/total,start=angle+.024,end=angle+share*Math.PI*2-.024;angle+=share*Math.PI*2;
      const surface=vizSvg('linearGradient',{id:`viz-ring-${id}-${entry.id}`,x1:0,y1:0,x2:1,y2:1});
      surface.append(vizSvg('stop',{offset:0,'stop-color':entry.color,'stop-opacity':.45}),vizSvg('stop',{offset:.35,'stop-color':entry.color}),vizSvg('stop',{offset:.62,'stop-color':entry.color,'stop-opacity':.64}),vizSvg('stop',{offset:1,'stop-color':entry.color}));ringDefinitions.append(surface);
      const path=vizSvg('path',{d:showcaseRingPath(start,end),fill:`url(#viz-ring-${id}-${entry.id})`,stroke:'#ffffffcc','stroke-width':1.2,class:'viz-ring-segment',opacity:state.category==='all'||state.category===entry.id?1:.27});wheel.append(path);path.addEventListener('click',()=>chooseCategory(entry.id),{signal});item.value.textContent=`${Math.round(share*100)}%`;item.button.setAttribute('aria-pressed',String(state.category===entry.id));item.button.setAttribute('aria-label',`${categoryLabel(entry.id)} ${entry.minutes} ${c.minutes}，${Math.round(share*100)}%`);
    }
    totalValue.textContent=String(state.category==='all'?total:view.total);totalLabel.textContent=state.category==='all'?c.minutes:`${categoryLabel(state.category)} · ${c.minutes}`;
    for(const item of bars){const entry=view.totals.find(value=>value.id===item.category.id);item.fill.style.setProperty('--bar-fraction',entry.minutes/maximum);item.number.textContent=`${entry.minutes} ${c.minutes}`;item.row.setAttribute('aria-pressed',String(state.category===entry.id));item.row.setAttribute('aria-label',`${categoryLabel(entry.id)} ${entry.minutes} ${c.minutes}`);}
    const selected=showcaseCategories.findIndex(item=>item.id===state.category);
    lineGlass.set({points,selected,animate:painted});ringGlass.set({values:view.totals.map(item=>item.minutes/total),selected,animate:painted});barGlass.set({values:view.totals.map(item=>item.minutes/maximum),selected,animate:painted});painted=true;
    dataTable.replaceChildren();const head=vizNode('tr','');for(const label of [c.date,...showcaseCategories.map(item=>categoryLabel(item.id))]){const th=vizNode('th','',label);th.scope='col';head.append(th);}const dataHead=vizNode('thead',''),dataBody=vizNode('tbody','');dataHead.append(head);dataTable.append(dataHead,dataBody);
    for(const date of view.dates){const tr=vizNode('tr','');tr.append(vizNode('td','',shortDate(date)));for(const category of showcaseCategories){const row=showcaseView({days:state.days,category:category.id}).daily.find(item=>item.date===date);const cell=vizNode('td','',`${row.minutes} ${c.minutes}`);cell.dataset.label=categoryLabel(category.id);tr.append(cell);}dataBody.append(tr);}updateTable();
  }
  update();return {snapshot:()=>({...state}),destroy(){abort.abort();disposeRows();searchControl.destroy();clearOpticalState(searchLabel);recordsGlass?.destroy();lineGlass.destroy();ringGlass.destroy();barGlass.destroy();host.replaceChildren();}};
}
