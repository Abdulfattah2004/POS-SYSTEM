export async function readAllPages<T extends {id:string}>(fetchPage:(after:string|null)=>PromiseLike<{data:T[]|null;error:{message?:string}|null}>,pageSize=500):Promise<T[]> {
 const rows:T[]=[];let after:string|null=null;
 for(;;){const {data,error}=await fetchPage(after);if(error)throw Object.assign(new Error(error.message??'Catalog request failed'),{cause:error});if(!Array.isArray(data))throw new Error('Incomplete catalog response');
  for(const row of data){if(!row.id||(after!==null&&row.id<=after))throw new Error('Catalog cursor did not advance');after=row.id;rows.push(row);}
  if(data.length<pageSize)return rows;
 }
}
