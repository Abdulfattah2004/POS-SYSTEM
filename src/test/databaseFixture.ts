export function databaseFixture(business:string,branch:string,owner:string){
return `
    CREATE ROLE authenticated NOLOGIN; CREATE ROLE anon NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT NULLIF(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    GRANT USAGE ON SCHEMA auth TO authenticated; GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
    CREATE TABLE public.businesses(id uuid PRIMARY KEY,owner_id uuid NOT NULL,name text);
    CREATE TABLE public.branches(id uuid PRIMARY KEY,business_id uuid REFERENCES businesses(id),name text);
    CREATE TABLE public.products(id text PRIMARY KEY,business_id uuid REFERENCES businesses(id),branch_id uuid REFERENCES branches(id),barcode text,name text NOT NULL,cost numeric DEFAULT 0,price numeric DEFAULT 0,stock integer DEFAULT 0,is_active boolean DEFAULT true,updated_at timestamptz DEFAULT now());
    CREATE TABLE public.inventory_entries(id text PRIMARY KEY,business_id uuid REFERENCES businesses(id),branch_id uuid REFERENCES branches(id),product_id text,product_name text,barcode text,quantity_added integer,purchase_price numeric,sale_price numeric,salesman_name text,date text,synced_at timestamptz);
    CREATE TABLE public.sales(id text PRIMARY KEY,business_id uuid NOT NULL,branch_id uuid,subtotal numeric NOT NULL,total numeric NOT NULL,currency text NOT NULL,exchange_rate numeric NOT NULL,cashier_name text NOT NULL,date text NOT NULL,refunded boolean,synced_at timestamptz);
    CREATE TABLE public.sale_items(id text PRIMARY KEY,sale_id text REFERENCES public.sales(id),business_id uuid,branch_id uuid,product_id text,product_name text,barcode text,quantity integer,sale_price numeric,purchase_price numeric,currency text);
    CREATE TABLE public.refunds(id text PRIMARY KEY,business_id uuid,branch_id uuid,sale_id text,total_refunded numeric,currency text,date text,cashier_name text,synced_at timestamptz);
    CREATE TABLE public.refund_items(id text PRIMARY KEY,refund_id text REFERENCES public.refunds(id),business_id uuid,branch_id uuid,product_id text,product_name text,barcode text,quantity integer,sale_price numeric,purchase_price numeric,currency text);
    ALTER TABLE public.sales ENABLE ROW LEVEL SECURITY; ALTER TABLE public.sale_items ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.refunds ENABLE ROW LEVEL SECURITY; ALTER TABLE public.refund_items ENABLE ROW LEVEL SECURITY;
    CREATE TABLE public.inventory_sync_operations(operation_id text PRIMARY KEY,business_id uuid,branch_id uuid,product_id text,quantity_delta integer,operation_type text,status text,payload jsonb);
    ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY; ALTER TABLE public.branches ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.products ENABLE ROW LEVEL SECURITY; ALTER TABLE public.inventory_entries ENABLE ROW LEVEL SECURITY;
    ALTER TABLE public.inventory_sync_operations ENABLE ROW LEVEL SECURITY;
    INSERT INTO public.businesses VALUES('${business}','${owner}','Shop');
    INSERT INTO public.branches VALUES('${branch}','${business}','Main');
    SET pos.review_approved='yes';
  `;

}
