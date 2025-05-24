import acorn from 'acorn'
import { IEngine } from './IEngine';
import { IQueryable, IQueryableState } from './IQueryable';
import { IDataSource } from './IDataSource';
import { Pool } from 'pg';
import { unflatten } from 'flat';
import { getColumnsMetadata, getRelationsMetadata, getTableMetadata } from './attributes';

export function parseProjection(
  mapSource: string,
  aliasMap: any
): Record<string, string> {
  const ast = acorn.parse(mapSource, { ecmaVersion: "latest" }) as any;

  const result: Record<string, string> = {};

  function flattenProps(node: any, prefix = "") {
    for (const prop of node.properties) {
      const key = prop.key.name || prop.key.value; // handle literals and identifiers
      const fullKey = prefix ? `${prefix}.${key}` : key;

      const valueNode = prop.value;

      if (valueNode.type === "ObjectExpression") {
        flattenProps(valueNode, fullKey);
      } else {
        // Build expression string, like `u.id`, `foo`, etc.
        result[fullKey] = extractExpression(valueNode);
      }
    }
  }

  function extractExpression(node: any): string {
    if (node.type === "TemplateLiteral") {
      const parts: string[] = [];

      for (let i = 0; i < node.quasis.length; i++) {
        const raw = node.quasis[i].value.raw.replace(/'/g, "''");
        if (raw.length > 0) {
          parts.push(`'${raw}'`);
        }

        const expr = node.expressions[i];
        if (expr) {
          const exprSql = extractExpression(expr);
          parts.push(`(${exprSql})::text`);
        }
      }

      return parts.join(" || ");
    }
    if (node.type === "CallExpression") {
      const callee = node.callee;

      if (callee.type === "MemberExpression") {
        const methodName = callee.property.name;
        const objectExpr = extractExpression(callee.object);

        // --- String methods ---
        if (methodName === "toLowerCase") {
          return `LOWER(${objectExpr})`;
        }
        if (methodName === "toUpperCase") {
          return `UPPER(${objectExpr})`;
        }
        if (methodName === "trim") {
          return `TRIM(${objectExpr})`;
        }
        if (methodName === "substring") {
          const args = node.arguments;
          const start = args[0]?.value ?? 0;
          const length = args[1]?.value ?? null;
          if (length !== null) {
            return `SUBSTRING(${objectExpr} FROM ${start + 1} FOR ${length})`;
          } else {
            return `SUBSTRING(${objectExpr} FROM ${start + 1})`;
          }
        }
        if (methodName === "includes") {
          const arg = node.arguments[0];
          if (arg.type === "Literal" && typeof arg.value === "string") {
            // string includes: LIKE %value%
            return `${objectExpr} LIKE '%${arg.value}%'`;
          } else {
            // Could be array includes, see below
          }
        }
        if (methodName === "startsWith") {
          const prefix = node.arguments[0]?.value;
          return `${objectExpr} LIKE '${prefix}%'`;
        }
        if (methodName === "endsWith") {
          const suffix = node.arguments[0]?.value;
          return `${objectExpr} LIKE '%${suffix}'`;
        }
        if (methodName === "replace") {
          const search = node.arguments[0]?.value;
          const replacement = node.arguments[1]?.value;
          return `REPLACE(${objectExpr}, '${search}', '${replacement}')`;
        }

        // --- Number methods ---
        if (methodName === "toFixed") {
          const digits = node.arguments[0]?.value ?? 0;
          // In SQL: ROUND(value, digits)
          return `ROUND(${objectExpr}, ${digits})`;
        }
        if (methodName === "toString") {
          // Cast number to text
          return `CAST(${objectExpr} AS TEXT)`;
        }

        // --- Date methods ---
        if (methodName === "getFullYear") {
          return `EXTRACT(YEAR FROM ${objectExpr})`;
        }
        if (methodName === "getMonth") {
          // JS months are 0-based, SQL is 1-based, so subtract 1
          return `(EXTRACT(MONTH FROM ${objectExpr}) - 1)`;
        }
        if (methodName === "getDate") {
          return `EXTRACT(DAY FROM ${objectExpr})`;
        }
        if (methodName === "getHours") {
          return `EXTRACT(HOUR FROM ${objectExpr})`;
        }
        if (methodName === "getMinutes") {
          return `EXTRACT(MINUTE FROM ${objectExpr})`;
        }
        if (methodName === "getSeconds") {
          return `EXTRACT(SECOND FROM ${objectExpr})`;
        }

        // --- Array methods ---
        if (methodName === "includes") {
          // Example: someArray.includes(value) -> value = ANY(array)
          // But if objectExpr is an array literal or column
          const arg = node.arguments[0];
          if (arg) {
            const valueExpr = extractExpression(arg);
            // Assuming objectExpr is an array column or literal
            return `${valueExpr} = ANY(${objectExpr})`;
          }
        }
      }
    }
    if (node.type === "LogicalExpression") {
      const left = extractExpression(node.left);
      const right = extractExpression(node.right);
      const operator =
        node.operator === "&&" ? "AND" : node.operator === "||" ? "OR" : null;
      if (!operator)
        throw new Error(`Unsupported logical operator: ${node.operator}`);
      return `(${left} ${operator} ${right})`;
    }

    if (node.type === "MemberExpression") {
      // node.property is usually Identifier or Literal
      const propertyName =
        node.property.type === "Identifier"
          ? aliasMap[node.property.name]
          : node.property.value; // for computed props

      // We assume node.object is the alias parameter (e.g., 'u'), ignore it
      return `${propertyName}`;
    }
    if (node.type === "Identifier") {
      return node.name;
    }
    if (node.type === "Literal") {
      if (typeof node.value === "string") {
        return `'${node.value}'`;
      }
      return node.value.toString();
    }
    if (node.type === "BinaryExpression") {
      const left = extractExpression(node.left);
      const right = extractExpression(node.right);
      const op = node.operator;

      switch (op) {
        case "==":
          return `${left} = ${right}`;
        case "!=":
          return `${left} <> ${right}`;
        case ">":
        case "<":
        case ">=":
        case "<=":
          return `${left} ${op} ${right}`;
        case "+": {
          const leftExpr = `(${left})`;
          const rightExpr = `(${right})`;

          const isDefinitelyNumber =
            node.left.type === "Literal" &&
            typeof node.left.value === "number" &&
            node.right.type === "Literal" &&
            typeof node.right.value === "number";

          if (isDefinitelyNumber) {
            return `${leftExpr} + ${rightExpr}`;
          }

          // Default to string concat
          return `${leftExpr}::text || ${rightExpr}::text`;
        }
        case "-":
        case "*":
        case "/":
        case "%":
          return `(${left} ${op} ${right})`;
        default:
          throw new Error(`Unsupported binary operator: ${op}`);
      }
    }

    return "<unsupported>";
  }

  const expressionBody = ast.body[0].expression.body;
  if (expressionBody.type === "ObjectExpression") {
    flattenProps(expressionBody);
  }

  return result;
}

function parseFilter(
  filterSource: string,
  aliasMap: Record<string, string>
): string {
  const ast = acorn.parse(filterSource, { ecmaVersion: "latest" }) as any;

  // The predicate function body expression: e.g. u.role == 'generic' && u.foo.uname.startsWith('Diana')
  const expr = ast.body[0].expression.body;

  function extractExpression(node: any): string {
    switch (node.type) {
      case "LogicalExpression": {
        const left = extractExpression(node.left);
        const right = extractExpression(node.right);
        const operator =
          node.operator === "&&" ? "AND" : node.operator === "||" ? "OR" : null;
        if (!operator)
          throw new Error(`Unsupported logical operator: ${node.operator}`);
        return `(${left} ${operator} ${right})`;
      }

      case "BinaryExpression": {
        const left = extractExpression(node.left);
        const right = extractExpression(node.right);
        switch (node.operator) {
          case "==":
            return `${left} = ${right}`;
          case "!=":
            return `${left} <> ${right}`;
          case ">":
          case "<":
          case ">=":
          case "<=":
            return `${left} ${node.operator} ${right}`;
          case "+":
            // Possibly string concatenation -> SQL ||
            return `(${left} || ${right})`;
          default:
            throw new Error(`Unsupported binary operator: ${node.operator}`);
        }
      }

      case "MemberExpression": {
        // Recursively build the full path, skipping root param identifier
        function buildPath(n: any): string[] {
          if (n.type === "MemberExpression") {
            return [
              ...buildPath(n.object),
              n.property.name || n.property.value,
            ];
          }
          if (n.type === "Identifier") {
            return []; // skip root identifier (e.g. "u")
          }
          throw new Error(`Unsupported node in member expression: ${n.type}`);
        }
        const fullPath = buildPath(node).join('.');
        if (!aliasMap[fullPath])
          throw new Error("Invalid map")
        return aliasMap[fullPath]
      }

      case "CallExpression": {
        const callee = node.callee;
        if (callee.type === "MemberExpression") {
          const method = callee.property.name;
          const objExpr = extractExpression(callee.object);

          if (method === "startsWith") {
            // Argument assumed to be a literal string
            const arg = node.arguments[0];
            if (arg.type !== "Literal")
              throw new Error("startsWith argument must be a literal");
            return `${objExpr} LIKE '${arg.value}%'`;
          }
          if (method === "endsWith") {
            const arg = node.arguments[0];
            if (arg.type !== "Literal")
              throw new Error("endsWith argument must be a literal");
            return `${objExpr} LIKE '%${arg.value}'`;
          }
          if (method === "includes") {
            const arg = node.arguments[0];
            if (arg.type !== "Literal")
              throw new Error("includes argument must be a literal");
            return `${objExpr} LIKE '%${arg.value}%'`;
          }
          // Add more string methods as needed
        }
        throw new Error(`Unsupported call expression: ${callee.type}`);
      }

      case "Identifier": {
        // Should never be alone in filter condition, return as is
        return `"${node.name}"`;
      }

      case "Literal": {
        if (typeof node.value === "string") {
          return `'${node.value.replace(/'/g, "''")}'`; // escape single quotes for SQL
        }
        return node.value.toString();
      }

      default:
        throw new Error(`Unsupported node type in filter: ${node.type}`);
    }
  }

  return extractExpression(expr);
}

function parseOrderSelector(source: string): string {
  const ast = acorn.parse(source, { ecmaVersion: "latest" }) as any;

  // Only support (x) => x.foo.bar or direct x => x.prop usage
  const body = ast.body[0].expression.body;

  function extractPath(node: any): string {
    if (node.type === "MemberExpression") {
      const parent = extractPath(node.object);
      const property = node.property.name || node.property.value;
      return parent ? `${parent}.${property}` : property;
    }
    if (node.type === "Identifier") {
      return ""; // skip root param
    }
    throw new Error("Unsupported order selector format");
  }

  return extractPath(body);
}


export class PostgresEngine implements IEngine {
  source: PostgresDataSource;

  constructor(source: PostgresDataSource) {
    this.source = source;
  }

  async toArray<T>({entityType, includes, distinct, filters, map, orders, skip, take}: IQueryableState<T>): Promise<T[]> {
    const tableMeta = getTableMetadata(entityType)
    const tableName = tableMeta.name

    // For each include, add LEFT JOIN and select related columns
    const columnAliasMap = {} as any
    const tableAliasMap = {
      '___t0': tableName
    } as any
    const tableAliasRelationMap = {} as any
    const columnMetaMap = getColumnsMetadata(entityType)

    for (const meta of Object.values(columnMetaMap)) {
      columnAliasMap[meta.fieldName] = `"___t0"."${meta.name}"`
    }

    const relationMetaMap = getRelationsMetadata(entityType)
    for (const [i, include] of includes.entries()) {
      const relationMeta = relationMetaMap[include]
      const targetEntity = relationMeta.target()
      const targetTableMeta = getTableMetadata(targetEntity)
      const targetColumnMeta = getColumnsMetadata(targetEntity)
      const tableAlias = `___t${i+1}`
      tableAliasMap[tableAlias] = targetTableMeta.name
      for (const meta of Object.values(targetColumnMeta)) {
        const columnAlias = `"${meta.fieldName}"."${meta.name}"`
      }
    }
        
    let innerSelect = Object.entries(columnAliasMap).map(([k, v]) => `${v} AS ${k}`).join(',')
    let aliasMap: Record<string, string> = {};

    if (map) {
      aliasMap = parseProjection(map.toString(), columnAliasMap);
      innerSelect = Object.entries(aliasMap)
        .map(([alias, expr]) => {
          // expr is already a SQL expression string
          return `${expr} AS "${alias}"`;
        })
        .join(", ");
    }

    // handle joins
    const joinClauses: string[] = [];

    const [mainTarget, ...joinTargets] = Object.entries(tableAliasMap)
    for (const joinTarget of joinTargets) {
      const meta = tableAliasRelationMap[joinTarget[0]]

      joinClauses.push(`LEFT JOIN "${joinTarget[1]}" AS "${joinTarget[0]}" ON "${joinTarget[0]}"."${meta.foreignKey}"="${mainTarget[0]}"."${meta.principalKey}"`)
    }



    // Compose inner query
    const selectClause = distinct ? "SELECT DISTINCT" : "SELECT";
    let innerSql = `${selectClause} ${innerSelect} FROM "${mainTarget[1]}" AS "${mainTarget[0]}" ${joinClauses.join(' ')}`;

    // Compose outer WHERE clause using alias names
    let outerWhereClause = "";
    if (filters.length > 0) {
      // We can safely use the alias names directly here because aliases exist in inner query output
      outerWhereClause = filters
        .map((filterSource: any) => {
          // Assuming filterSource uses alias names now, you can convert filterSource to SQL
          // Or you might want to reuse your parseFilter with alias names directly
          return parseFilter(filterSource, aliasMap);
        })
        .join(" AND ");
    }

    // Wrap inner select as a subquery
    let sql = `SELECT * FROM (${innerSql}) AS sub`;

    if (outerWhereClause) {
      sql += ` WHERE ${outerWhereClause}`;
    }

    if (orders.length > 0) {
      const orderClauses = orders.map(({ source, descending }) => {
        const orderKey = parseOrderSelector(source);
        return `"${orderKey}" ${descending ? "DESC" : "ASC"}`;
      });
      sql += ` ORDER BY ${orderClauses.join(", ")}`;
    }

    if (take !== undefined) {
      sql += ` LIMIT ${take}`;
    }
    if (skip) {
      sql += ` OFFSET ${skip}`;
    }

    const client = await this.source.pool.connect();
    try {
      console.log(sql);
      const result = await client.query(sql);
      return result.rows.map((v) => unflatten(v));
    } finally {
      client.release();
    }
  }

  async first<T>(q: IQueryableState<T>): Promise<T | undefined> {
    q.take = 1
    const arr = await this.toArray(q);
    return arr[0];
  }

  async count<T>(q: IQueryable<T>): Promise<number> {
    const entityType = (q as any)._entityType;
    const tableMeta = getTableMetadata(entityType)
    const tableName = tableMeta.name

    let innerSelect = "*";
    let aliasMap: Record<string, string> = {};

    if ((q as any)._map) {
      aliasMap = parseProjection((q as any)._map, entityType);
      innerSelect = Object.entries(aliasMap)
        .map(([alias, expr]) => `${expr} AS "${alias}"`)
        .join(", ");
    }

    const selectClause = (q as any)._distinct ? "SELECT DISTINCT" : "SELECT";
    let innerSql = `${selectClause} ${innerSelect} FROM "${tableName}z`;

    const filters = (q as any)._filters || [];
    let outerWhereClause = "";
    if (filters.length > 0) {
      outerWhereClause = filters
        .map((filterSource: any) => parseFilter(filterSource, null as any)) // fix this
        .join(" AND ");
    }

    let sql = `SELECT COUNT(*) FROM (${innerSql}) AS "sub"`;

    if (outerWhereClause) {
      sql += ` WHERE ${outerWhereClause}`;
    }

    const client = await this.source.pool.connect();
    try {
      const result = await client.query(sql);
      return parseInt(result.rows[0].count, 10);
    } finally {
      client.release();
    }
  }
}

export class PostgresDataSource implements IDataSource {
  engine: IEngine;
  pool: Pool;

  constructor(connectionString: string) {
    this.engine = new PostgresEngine(this);
    this.pool = new Pool({ connectionString });
  }
}
