export const showcaseCategories = [
  {id:'design',zh:'设计',en:'Design',color:'#4d9689'},
  {id:'reading',zh:'阅读',en:'Reading',color:'#658dc3'},
  {id:'building',zh:'制作',en:'Building',color:'#aa8ebd'},
  {id:'planning',zh:'整理',en:'Planning',color:'#c2a061'},
];
const showcaseDailyMinutes = [
  [85,35,60,25],[115,45,75,30],[70,55,50,20],[125,30,95,35],[140,40,105,25],[65,80,35,20],[90,65,55,30],
  [110,45,80,25],[145,35,90,30],[95,60,75,35],[160,40,100,20],[125,55,115,30],[80,75,60,25],[135,50,95,40],
];
const showcaseTaskNames = {
  design:[['材质与光线','Material & light'],['界面草图','Interface sketches'],['色彩采集','Color studies']],
  reading:[['灵感笔记','Inspiration notes'],['阅读时光','Reading time'],['设计观察','Design observations']],
  building:[['透镜实验','Lens experiments'],['组件制作','Component workshop'],['交互打磨','Interaction details']],
  planning:[['归档与整理','Archive & organize'],['下周的想法','Ideas for next week'],['工作台复位','Reset the workspace']],
};
export const showcaseRecords = Object.freeze(showcaseDailyMinutes.flatMap((minutes,day) => showcaseCategories.map((category,index) => Object.freeze({
  id:`demo-${day}-${category.id}`,date:`2026-09-${String(day+5).padStart(2,'0')}`,category:category.id,minutes:minutes[index],
  titleZh:showcaseTaskNames[category.id][day%3][0],titleEn:showcaseTaskNames[category.id][day%3][1],
  progress:day===13&&index===2?72:100,
}))));

export function showcaseView({days=7,category='all',query='',sort='date',direction='desc'}={}){
  const count=days===14?14:7,dates=[...new Set(showcaseRecords.map(row=>row.date))].slice(-count);
  const period=showcaseRecords.filter(row=>dates.includes(row.date));
  const selected=period.filter(row=>category==='all'||row.category===category);
  const totals=showcaseCategories.map(item=>({...item,minutes:period.filter(row=>row.category===item.id).reduce((sum,row)=>sum+row.minutes,0)}));
  const daily=dates.map(date=>({date,minutes:selected.filter(row=>row.date===date).reduce((sum,row)=>sum+row.minutes,0)}));
  const normalize=value=>value.toLocaleLowerCase().replace(/\s+/g,'');
  const search=normalize(query);
  const rows=selected.filter(row=>{
    const day=Number(row.date.slice(-2));
    return normalize(`${row.titleZh} ${row.titleEn} ${row.date} 9月${day}日 Sep${day} September${day} ${row.category} ${showcaseCategories.find(item=>item.id===row.category).zh}`).includes(search);
  });
  const sign=direction==='asc'?1:-1;
  rows.sort((a,b)=>sign*(sort==='minutes'?a.minutes-b.minutes:sort==='progress'?a.progress-b.progress:a.date.localeCompare(b.date))||a.id.localeCompare(b.id));
  return {dates,totals,daily,rows,total:selected.reduce((sum,row)=>sum+row.minutes,0)};
}

export function showcaseLinePoints(daily,width=640,height=230){
  const max=Math.max(60,Math.ceil(Math.max(...daily.map(day=>day.minutes))/60)*60);
  return {max,points:daily.map((day,index)=>({x:32+index*(width-64)/Math.max(1,daily.length-1),y:height-26-day.minutes/max*(height-52),...day}))};
}

export function showcaseRingPath(start,end,outer=94,inner=69){
  const point=(radius,angle)=>[120+radius*Math.cos(angle-Math.PI/2),120+radius*Math.sin(angle-Math.PI/2)];
  const a=point(outer,start),b=point(outer,end),c=point(inner,end),d=point(inner,start),large=end-start>Math.PI?1:0;
  return `M${a} A${outer},${outer} 0 ${large} 1 ${b} L${c} A${inner},${inner} 0 ${large} 0 ${d} Z`;
}
