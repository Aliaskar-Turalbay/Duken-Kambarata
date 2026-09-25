-- =====================================================================
--  Дүкен Касса — схема базы данных для Supabase
--  Выполните этот файл целиком: Supabase → SQL Editor → New query → Run.
--  Скрипт можно запускать повторно: он не удаляет данные.
-- =====================================================================

-- ---------- Сотрудники ----------
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  full_name   text not null default '',
  role        text not null default 'cashier' check (role in ('owner', 'cashier')),
  created_at  timestamptz not null default now()
);

-- Новый пользователь получает профиль. Самый первый — владелец, остальные — кассиры.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, full_name, role)
  values (
    new.id,
    coalesce(nullif(new.raw_user_meta_data->>'full_name', ''), split_part(new.email, '@', 1)),
    case when exists (select 1 from public.profiles where role = 'owner') then 'cashier' else 'owner' end
  )
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- Профили для пользователей, созданных до запуска скрипта
insert into public.profiles (id, full_name, role)
select u.id, split_part(u.email, '@', 1),
       case when row_number() over (order by u.created_at) = 1
             and not exists (select 1 from public.profiles where role = 'owner')
            then 'owner' else 'cashier' end
from auth.users u
where not exists (select 1 from public.profiles p where p.id = u.id);

create or replace function public.is_staff()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid())
$$;

create or replace function public.is_owner()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'owner')
$$;

-- ---------- Товары ----------
create table if not exists public.products (
  id          uuid primary key default gen_random_uuid(),
  name        text not null check (length(btrim(name)) > 0),
  category    text not null default 'Без категории',
  unit        text not null default 'шт' check (unit in ('шт', 'кг')),
  barcode     text,
  plu         text,
  cost        numeric(12,2) not null default 0 check (cost >= 0),
  price       numeric(12,2) not null check (price > 0),
  stock       numeric(12,3) not null default 0,
  min_stock   numeric(12,3) not null default 0 check (min_stock >= 0),
  archived    boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- Штрихкод и PLU уникальны среди действующих товаров
create unique index if not exists products_barcode_uniq on public.products (barcode)
  where barcode is not null and barcode <> '' and not archived;
create unique index if not exists products_plu_uniq on public.products (plu)
  where plu is not null and plu <> '' and not archived;

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
drop trigger if exists products_touch on public.products;
create trigger products_touch before update on public.products
  for each row execute function public.touch_updated_at();

-- ---------- Чеки ----------
create sequence if not exists public.receipt_no_seq;

create table if not exists public.receipts (
  id            uuid primary key default gen_random_uuid(),
  no            bigint not null unique default nextval('public.receipt_no_seq'),
  created_at    timestamptz not null default now(),
  cashier_id    uuid references public.profiles(id),
  cashier_name  text not null default '',
  method        text not null check (method in ('cash', 'card', 'qr')),
  total         numeric(12,2) not null default 0,
  cost_total    numeric(12,2) not null default 0,
  received      numeric(12,2) not null default 0,
  change        numeric(12,2) not null default 0,
  returned_at   timestamptz,
  returned_by   uuid references public.profiles(id)
);
create index if not exists receipts_created_idx on public.receipts (created_at desc);

create table if not exists public.receipt_lines (
  id          bigserial primary key,
  receipt_id  uuid not null references public.receipts(id) on delete cascade,
  product_id  uuid references public.products(id),
  name        text not null,
  unit        text not null,
  qty         numeric(12,3) not null check (qty > 0),
  price       numeric(12,2) not null,
  cost        numeric(12,2) not null default 0,
  sum         numeric(12,2) not null
);
create index if not exists receipt_lines_receipt_idx on public.receipt_lines (receipt_id);

-- ---------- Движение товара ----------
create table if not exists public.stock_moves (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  type        text not null check (type in ('in', 'writeoff', 'inventory', 'return')),
  note        text not null default '',
  user_id     uuid references public.profiles(id),
  user_name   text not null default '',
  receipt_id  uuid references public.receipts(id)
);
create index if not exists stock_moves_created_idx on public.stock_moves (created_at desc);

create table if not exists public.stock_move_lines (
  id          bigserial primary key,
  move_id     uuid not null references public.stock_moves(id) on delete cascade,
  product_id  uuid references public.products(id),
  name        text not null,
  unit        text not null,
  qty         numeric(12,3) not null,
  cost        numeric(12,2) not null default 0
);
create index if not exists stock_move_lines_move_idx on public.stock_move_lines (move_id);

-- =====================================================================
--  Доступ (Row Level Security)
--  Анонимный посетитель не видит ничего. Остатки, чеки и движения
--  меняются только через функции ниже, а не прямой записью.
-- =====================================================================
alter table public.profiles         enable row level security;
alter table public.products         enable row level security;
alter table public.receipts         enable row level security;
alter table public.receipt_lines    enable row level security;
alter table public.stock_moves      enable row level security;
alter table public.stock_move_lines enable row level security;

revoke all on public.profiles, public.products, public.receipts, public.receipt_lines,
              public.stock_moves, public.stock_move_lines from anon;
revoke insert, update, delete on public.receipts, public.receipt_lines,
              public.stock_moves, public.stock_move_lines from authenticated;

-- Профили: сотрудники видят друг друга; себе можно менять только имя
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated using (public.is_staff());
drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());
revoke insert, update, delete on public.profiles from authenticated;
grant update (full_name) on public.profiles to authenticated;

-- Товары: сотрудники видят и заводят новые; остаток напрямую не меняется
drop policy if exists products_select on public.products;
create policy products_select on public.products for select to authenticated using (public.is_staff());
drop policy if exists products_insert on public.products;
create policy products_insert on public.products for insert to authenticated with check (public.is_staff());
drop policy if exists products_update on public.products;
create policy products_update on public.products for update to authenticated
  using (public.is_staff()) with check (public.is_staff());
revoke update, delete on public.products from authenticated;
grant update (name, category, unit, barcode, plu, cost, price, min_stock) on public.products to authenticated;
-- В архив (удаление товара) — только владелец, через функцию archive_product

-- Чеки: владелец видит все, кассир — только свои
drop policy if exists receipts_select on public.receipts;
create policy receipts_select on public.receipts for select to authenticated
  using (public.is_owner() or cashier_id = auth.uid());
drop policy if exists receipt_lines_select on public.receipt_lines;
create policy receipt_lines_select on public.receipt_lines for select to authenticated
  using (exists (select 1 from public.receipts r where r.id = receipt_id));

-- Движения склада: видят все сотрудники
drop policy if exists stock_moves_select on public.stock_moves;
create policy stock_moves_select on public.stock_moves for select to authenticated using (public.is_staff());
drop policy if exists stock_move_lines_select on public.stock_move_lines;
create policy stock_move_lines_select on public.stock_move_lines for select to authenticated using (public.is_staff());

-- =====================================================================
--  Серверные операции. Каждая выполняется целиком или не выполняется.
-- =====================================================================

-- Продажа. p_lines: [{"product_id": "...", "qty": 1.25}, ...]
create or replace function public.create_sale(p_method text, p_received numeric, p_lines jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r        public.receipts;
  l        jsonb;
  p        public.products;
  v_qty    numeric;
  v_total  numeric := 0;
  v_cost   numeric := 0;
  v_name   text;
begin
  if not public.is_staff() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  if p_method not in ('cash', 'card', 'qr') then raise exception 'Неизвестный способ оплаты'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'Чек пустой';
  end if;

  -- 1) Проверяем весь чек и блокируем товары (по порядку id, чтобы кассы не мешали друг другу)
  for l in select value from jsonb_array_elements(p_lines) order by value->>'product_id' loop
    v_qty := round((l->>'qty')::numeric, 3);
    if v_qty is null or v_qty <= 0 then raise exception 'Неверное количество в чеке'; end if;
    select * into p from public.products where id = (l->>'product_id')::uuid for update;
    if not found then raise exception 'Товар не найден в каталоге'; end if;
    if p.unit = 'шт' and v_qty <> trunc(v_qty) then
      raise exception 'Товар «%» продаётся поштучно', p.name;
    end if;
    v_total := v_total + round(p.price * v_qty);
    v_cost  := v_cost + p.cost * v_qty;
  end loop;

  if p_method = 'cash' then
    p_received := coalesce(p_received, v_total);
    if p_received < v_total then raise exception 'Получено меньше суммы чека'; end if;
  else
    p_received := v_total;
  end if;

  -- 2) Только теперь берём номер чека — так в нумерации не будет пропусков из-за ошибок
  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.receipts (cashier_id, cashier_name, method, total, cost_total, received, change)
  values (auth.uid(), coalesce(v_name, ''), p_method, v_total, round(v_cost), p_received, p_received - v_total)
  returning * into r;

  -- 3) Строки чека и списание остатков. Цена и себестоимость — из базы, не из браузера.
  for l in select value from jsonb_array_elements(p_lines) order by value->>'product_id' loop
    v_qty := round((l->>'qty')::numeric, 3);
    select * into p from public.products where id = (l->>'product_id')::uuid;
    insert into public.receipt_lines (receipt_id, product_id, name, unit, qty, price, cost, sum)
    values (r.id, p.id, p.name, p.unit, v_qty, p.price, p.cost, round(p.price * v_qty));
    update public.products set stock = stock - v_qty where id = p.id;
  end loop;

  return to_jsonb(r) || jsonb_build_object('lines',
    (select jsonb_agg(to_jsonb(x) order by x.id) from public.receipt_lines x where x.receipt_id = r.id));
end $$;

-- Возврат всего чека: товар возвращается на склад
create or replace function public.return_receipt(p_receipt uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  r      public.receipts;
  x      public.receipt_lines;
  v_move uuid;
  v_name text;
begin
  if not public.is_staff() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  select * into r from public.receipts where id = p_receipt for update;
  if not found then raise exception 'Чек не найден'; end if;
  if not public.is_owner() and r.cashier_id is distinct from auth.uid() then
    raise exception 'Возврат по чужому чеку оформляет владелец' using errcode = '42501';
  end if;
  if r.returned_at is not null then raise exception 'По этому чеку уже оформлен возврат'; end if;

  update public.receipts set returned_at = now(), returned_by = auth.uid() where id = r.id returning * into r;

  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.stock_moves (type, note, user_id, user_name, receipt_id)
  values ('return', 'Возврат по чеку № ' || r.no, auth.uid(), coalesce(v_name, ''), r.id)
  returning id into v_move;

  for x in select * from public.receipt_lines where receipt_id = r.id order by product_id loop
    if x.product_id is not null then
      update public.products set stock = stock + x.qty where id = x.product_id;
    end if;
    insert into public.stock_move_lines (move_id, product_id, name, unit, qty, cost)
    values (v_move, x.product_id, x.name, x.unit, x.qty, x.cost);
  end loop;

  return to_jsonb(r) || jsonb_build_object('lines',
    (select jsonb_agg(to_jsonb(y) order by y.id) from public.receipt_lines y where y.receipt_id = r.id));
end $$;

-- Приход по накладной. p_lines: [{"product_id": "...", "qty": 10, "cost": 410}, ...]
create or replace function public.post_incoming(p_supplier text, p_doc text, p_lines jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  l      jsonb;
  p      public.products;
  v_qty  numeric;
  v_cost numeric;
  v_move uuid;
  v_name text;
begin
  if not public.is_staff() then raise exception 'Нет доступа' using errcode = '42501'; end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'В накладной нет строк';
  end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  insert into public.stock_moves (type, note, user_id, user_name)
  values ('in', concat_ws(', ', nullif(btrim(p_supplier), ''), 'накладная № ' || nullif(btrim(p_doc), '')),
          auth.uid(), coalesce(v_name, ''))
  returning id into v_move;

  for l in select value from jsonb_array_elements(p_lines) order by value->>'product_id' loop
    v_qty  := round((l->>'qty')::numeric, 3);
    v_cost := coalesce((l->>'cost')::numeric, 0);
    if v_qty is null or v_qty <= 0 then raise exception 'Неверное количество в накладной'; end if;
    if v_cost < 0 then raise exception 'Закупочная цена не может быть отрицательной'; end if;

    select * into p from public.products where id = (l->>'product_id')::uuid for update;
    if not found then raise exception 'Товар не найден в каталоге'; end if;

    update public.products
       set stock = stock + v_qty,
           cost  = case when v_cost > 0 then v_cost else cost end
     where id = p.id;
    insert into public.stock_move_lines (move_id, product_id, name, unit, qty, cost)
    values (v_move, p.id, p.name, p.unit, v_qty, case when v_cost > 0 then v_cost else p.cost end);
  end loop;
  return v_move;
end $$;

-- Списание — только владелец
create or replace function public.write_off(p_product uuid, p_qty numeric, p_reason text)
returns uuid language plpgsql security definer set search_path = public as $$
declare p public.products; v_move uuid; v_name text;
begin
  if not public.is_owner() then raise exception 'Списание доступно только владельцу' using errcode = '42501'; end if;
  if p_qty is null or p_qty <= 0 then raise exception 'Укажите количество больше нуля'; end if;
  select * into p from public.products where id = p_product for update;
  if not found then raise exception 'Товар не найден'; end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  update public.products set stock = stock - round(p_qty, 3) where id = p.id;
  insert into public.stock_moves (type, note, user_id, user_name)
  values ('writeoff', coalesce(p_reason, ''), auth.uid(), coalesce(v_name, '')) returning id into v_move;
  insert into public.stock_move_lines (move_id, product_id, name, unit, qty, cost)
  values (v_move, p.id, p.name, p.unit, round(p_qty, 3), p.cost);
  return v_move;
end $$;

-- Инвентаризация: фактический остаток — только владелец
create or replace function public.set_actual_stock(p_product uuid, p_fact numeric)
returns numeric language plpgsql security definer set search_path = public as $$
declare p public.products; v_delta numeric; v_move uuid; v_name text;
begin
  if not public.is_owner() then raise exception 'Инвентаризация доступна только владельцу' using errcode = '42501'; end if;
  if p_fact is null or p_fact < 0 then raise exception 'Введите фактический остаток'; end if;
  select * into p from public.products where id = p_product for update;
  if not found then raise exception 'Товар не найден'; end if;

  v_delta := round(p_fact, 3) - p.stock;
  if v_delta = 0 then return 0; end if;

  select full_name into v_name from public.profiles where id = auth.uid();
  update public.products set stock = round(p_fact, 3) where id = p.id;
  insert into public.stock_moves (type, note, user_id, user_name)
  values ('inventory', case when v_delta > 0 then 'Излишек' else 'Недостача' end, auth.uid(), coalesce(v_name, ''))
  returning id into v_move;
  insert into public.stock_move_lines (move_id, product_id, name, unit, qty, cost)
  values (v_move, p.id, p.name, p.unit, v_delta, p.cost);
  return v_delta;
end $$;

-- Убрать товар из каталога (история продаж сохраняется) — только владелец
create or replace function public.archive_product(p_product uuid)
returns void language plpgsql security definer set search_path = public as $$
begin
  if not public.is_owner() then raise exception 'Удалять товары может только владелец' using errcode = '42501'; end if;
  update public.products set archived = true where id = p_product;
end $$;

-- Функции вызывают только вошедшие сотрудники
revoke execute on function public.create_sale(text, numeric, jsonb)        from public, anon;
revoke execute on function public.return_receipt(uuid)                     from public, anon;
revoke execute on function public.post_incoming(text, text, jsonb)         from public, anon;
revoke execute on function public.write_off(uuid, numeric, text)           from public, anon;
revoke execute on function public.set_actual_stock(uuid, numeric)          from public, anon;
revoke execute on function public.archive_product(uuid)                    from public, anon;
grant  execute on function public.create_sale(text, numeric, jsonb)        to authenticated;
grant  execute on function public.return_receipt(uuid)                     to authenticated;
grant  execute on function public.post_incoming(text, text, jsonb)         to authenticated;
grant  execute on function public.write_off(uuid, numeric, text)           to authenticated;
grant  execute on function public.set_actual_stock(uuid, numeric)          to authenticated;
grant  execute on function public.archive_product(uuid)                    to authenticated;

-- Живое обновление остатков на всех кассах
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables
                     where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'products') then
    alter publication supabase_realtime add table public.products;
  end if;
end $$;
