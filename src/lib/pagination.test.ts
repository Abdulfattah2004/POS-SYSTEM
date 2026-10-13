import {expect,it} from 'vitest';
import {readAllPages} from './pagination';
it('reads every scoped catalog page and rejects partial catalog failures',async()=>{const all=Array.from({length:1101},(_,i)=>({id:String(i).padStart(5,'0')}));expect(await readAllPages(async after=>({data:all.filter(r=>after===null||r.id>after).slice(0,500),error:null}))).toHaveLength(1101);await expect(readAllPages(async()=>({data:null,error:{message:'denied'}}))).rejects.toThrow('denied');await expect(readAllPages(async()=>({data:[{id:'a'}],error:null}),1)).rejects.toThrow('cursor');});
