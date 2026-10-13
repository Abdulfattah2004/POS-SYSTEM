type Notice={id:number;kind:'error'|'success'|'info';message:string};
let notices:Notice[]=[];let sequence=0;
const listeners=new Set<()=>void>();
function notify(kind:Notice['kind'],message:string) {
 notices=kind==='error'?notices.filter(notice=>notice.message!==message):notices.filter(notice=>notice.kind==='error');
 notices=[...notices,{id:++sequence,kind,message:String(message)}];listeners.forEach(listener=>listener());
}
// Diagnostic compatibility store. Action-local feedback renders operation
// results; there is no global banner, popup or automatic error dismissal.
export const toast={error:(message:string)=>notify('error',message),success:(message:string)=>notify('success',message),info:(message:string)=>notify('info',message)};
export const subscribeNotices=(listener:()=>void)=>{listeners.add(listener);return ()=>{listeners.delete(listener);};};
export const getNotices=()=>notices;
export function dismissNotice(id:number) {notices=notices.filter(notice=>notice.id!==id);listeners.forEach(listener=>listener());}
