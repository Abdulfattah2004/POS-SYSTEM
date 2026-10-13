import type {Currency} from '@/types/pos';
// Each sale/refund has its own cent rounding, followed by whole-LBP
// settlement rounding. Batch refund previews must sum those child amounts.
export function settlementPreview(lines:{saleId?:string;quantity:number;salePrice:number}[],currency:Currency,rate:number){
 const groups=new Map<string,number>();
 for(const line of lines){const key=line.saleId??'';groups.set(key,(groups.get(key)??0)+line.quantity*line.salePrice);}
 let cents=0,total=0;
 for(const amount of groups.values()){
  const rounded=Math.round((amount+Number.EPSILON)*100);cents+=rounded;
  total+=currency==='USD'?rounded/100:Math.round(rounded/100*rate);
 }
 return {subtotal:cents/100,total:currency==='USD'?cents/100:total};
}
