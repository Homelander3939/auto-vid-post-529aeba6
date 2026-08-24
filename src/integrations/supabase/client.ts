/**
 * Local-only browser persistence adapter.
 *
 * The UI historically imports this object as `supabase`. Preserve that API
 * shape, but route records and files to the local worker on port 3001.
 */

const LOCAL_WORKER_URL = 'http://127.0.0.1:3001';

type LocalError = { message: string };
type LocalResult<T = any> = { data: T; error: LocalError | null; count?: number };
type Filter = { op: string; column?: string; value?: any; operator?: string };

class LocalQueryBuilder implements PromiseLike<LocalResult> {
  private action: 'select' | 'insert' | 'update' | 'delete' = 'select';
  private payload: any = null;
  private columns = '*';
  private filters: Filter[] = [];
  private orders: Array<{ column: string; ascending: boolean }> = [];
  private rowLimit: number | null = null;
  private returnMode: 'many' | 'single' | 'maybeSingle' = 'many';
  private returning = false;

  constructor(private readonly table: string) {}

  select(columns = '*') {
    this.columns = columns || '*';
    if (this.action !== 'select') this.returning = true;
    return this;
  }

  insert(payload: any) { this.action = 'insert'; this.payload = payload; return this; }
  update(payload: any) { this.action = 'update'; this.payload = payload || {}; return this; }
  delete() { this.action = 'delete'; return this; }
  eq(column: string, value: any) { return this.addFilter('eq', column, value); }
  neq(column: string, value: any) { return this.addFilter('neq', column, value); }
  is(column: string, value: any) { return this.addFilter('is', column, value); }

  in(column: string, value: any[]) {
    this.filters.push({ op: 'in', column, value: Array.isArray(value) ? value : [] });
    return this;
  }

  not(column: string, operator: string, value: any) {
    this.filters.push({ op: 'not', column, operator, value });
    return this;
  }

  match(values: Record<string, any>) {
    for (const [column, value] of Object.entries(values || {})) this.eq(column, value);
    return this;
  }

  order(column: string, options?: { ascending?: boolean }) {
    this.orders.push({ column, ascending: options?.ascending !== false });
    return this;
  }

  limit(value: number) { this.rowLimit = Number(value); return this; }
  single() { this.returnMode = 'single'; return this; }
  maybeSingle() { this.returnMode = 'maybeSingle'; return this; }

  then<TResult1 = LocalResult, TResult2 = never>(
    onfulfilled?: ((value: LocalResult) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: any) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    return this.execute().then(onfulfilled, onrejected);
  }

  private addFilter(op: string, column: string, value: any) {
    this.filters.push({ op, column, value });
    return this;
  }

  private normalize(data: any): LocalResult {
    if (this.returnMode === 'many') return { data, error: null };
    const rows = Array.isArray(data) ? data : data == null ? [] : [data];
    if (this.returnMode === 'single' && rows.length !== 1) {
      return { data: null, error: { message: `Expected one ${this.table} row, found ${rows.length}` } };
    }
    if (this.returnMode === 'maybeSingle' && rows.length > 1) {
      return { data: null, error: { message: `Expected at most one ${this.table} row, found ${rows.length}` } };
    }
    return { data: rows[0] || null, error: null };
  }

  private async execute(): Promise<LocalResult> {
    try {
      const common = { table: this.table, filters: this.filters };
      let path = '/api/db/select';
      let body: Record<string, any> = {
        ...common,
        columns: this.columns,
        order: this.orders,
        limit: this.rowLimit,
      };

      if (this.action === 'insert') {
        path = '/api/db/insert';
        body = { table: this.table, payload: this.payload, select: this.returning ? this.columns : false };
      } else if (this.action === 'update') {
        path = '/api/db/update';
        body = { ...common, payload: this.payload, select: this.returning ? this.columns : false };
      } else if (this.action === 'delete') {
        path = '/api/db/delete';
        body = common;
      }

      const response = await fetch(`${LOCAL_WORKER_URL}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.error) {
        return { data: null, error: { message: result?.error || `Local database HTTP ${response.status}` } };
      }
      return this.normalize(result?.data ?? null);
    } catch (error) {
      return { data: null, error: { message: `Local database unavailable: ${(error as Error).message}` } };
    }
  }
}

class LocalChannel {
  on() { return this; }
  subscribe() { return this; }
  unsubscribe() {}
}

function objectUrl(bucket: string, objectPath: string) {
  const encodedPath = String(objectPath || '').split('/').filter(Boolean).map(encodeURIComponent).join('/');
  return `${LOCAL_WORKER_URL}/api/local-storage/${encodeURIComponent(bucket)}/${encodedPath}`;
}

export const supabase: any = {
  from(table: string) { return new LocalQueryBuilder(table); },

  storage: {
    from(bucket: string) {
      return {
        async upload(objectPath: string, value: Blob | ArrayBuffer | Uint8Array, options?: { contentType?: string; upsert?: boolean }) {
          try {
            const response = await fetch(objectUrl(bucket, objectPath), {
              method: 'PUT',
              headers: {
                'Content-Type': options?.contentType || (value instanceof Blob ? value.type : '') || 'application/octet-stream',
                'X-Upsert': options?.upsert ? 'true' : 'false',
              },
              body: value as BodyInit,
            });
            const result = await response.json().catch(() => ({}));
            return response.ok ? result : { data: null, error: { message: result?.error || `Local upload HTTP ${response.status}` } };
          } catch (error) {
            return { data: null, error: { message: `Local upload unavailable: ${(error as Error).message}` } };
          }
        },
        getPublicUrl(objectPath: string) { return { data: { publicUrl: objectUrl(bucket, objectPath) } }; },
        async remove(paths: string[]) {
          try {
            const response = await fetch(`${LOCAL_WORKER_URL}/api/local-storage/remove`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ bucket, paths }),
            });
            const result = await response.json().catch(() => ({}));
            return response.ok ? result : { data: null, error: { message: result?.error || `Local remove HTTP ${response.status}` } };
          } catch (error) {
            return { data: null, error: { message: `Local remove unavailable: ${(error as Error).message}` } };
          }
        },
      };
    },
  },

  functions: {
    async invoke(name: string, options?: { body?: any }) {
      try {
        const response = await fetch(`${LOCAL_WORKER_URL}/api/local-functions/${encodeURIComponent(name)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(options?.body || {}),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || result?.error) {
          return { data: result || null, error: { message: result?.error || `Local function HTTP ${response.status}` } };
        }
        return { data: result, error: null };
      } catch (error) {
        return { data: null, error: { message: `Local function unavailable: ${(error as Error).message}` } };
      }
    },
  },

  channel() { return new LocalChannel(); },
  removeChannel(channel: LocalChannel) { channel?.unsubscribe?.(); },
};
