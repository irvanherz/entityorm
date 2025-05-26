import acorn from 'acorn'
import { IEngine } from './IEngine'
import { IQueryable, IQueryableState, QueryOperation } from './IQueryable'
import { IDataSource } from './IDataSource'
import { Pool } from 'pg'
import { flatten, unflatten } from 'flat'
import { getColumnsMetadata, getRelationsMetadata, getTableMetadata } from './attributes'
import walk from 'acorn-walk'
import _ from 'lodash'

export function parseProjection(
  mapper: string,
  selects: { target: string; alias: string }[],
  externalScope: Record<string, any> = {}
): { target: string; alias: string }[] {
  const ast = acorn.parse(mapper, { ecmaVersion: 'latest' }) as any

  function fieldResolver(path: string): string {
    const target = selects.find((item) => item.alias === path)
    if (!target) {
      const replacement = _.get(externalScope, path)
      if (replacement === undefined) return '[Unknown target]'
      return replacement
    }
    return target.target
  }

  function exprToString(node: any, scope: Record<string, any>): string {
    switch (node.type) {
      case 'CallExpression': {
        const callee = node.callee

        if (callee.type === 'MemberExpression') {
          const methodName = callee.property.name
          const objectExpr = exprToString(callee.object, scope)

          // --- String methods ---
          if (methodName === 'toLowerCase') {
            return `LOWER(${objectExpr})`
          }
          if (methodName === 'toUpperCase') {
            return `UPPER(${objectExpr})`
          }
          if (methodName === 'trim') {
            return `TRIM(${objectExpr})`
          }
          if (methodName === 'substring') {
            const args = node.arguments
            const start = args[0]?.value ?? 0
            const length = args[1]?.value ?? null
            if (length !== null) {
              return `SUBSTRING(${objectExpr} FROM ${start + 1} FOR ${length})`
            } else {
              return `SUBSTRING(${objectExpr} FROM ${start + 1})`
            }
          }
          if (methodName === 'includes') {
            const arg = node.arguments[0]
            if (arg.type === 'Literal' && typeof arg.value === 'string') {
              // string includes: LIKE %value%
              return `${objectExpr} LIKE '%${arg.value}%'`
            } else {
              // Could be array includes, see below
            }
          }
          if (methodName === 'startsWith') {
            const prefix = node.arguments[0]?.value
            return `${objectExpr} LIKE '${prefix}%'`
          }
          if (methodName === 'endsWith') {
            const suffix = node.arguments[0]?.value
            return `${objectExpr} LIKE '%${suffix}'`
          }
          if (methodName === 'replace') {
            const search = node.arguments[0]?.value
            const replacement = node.arguments[1]?.value
            return `REPLACE(${objectExpr}, '${search}', '${replacement}')`
          }

          // --- Number methods ---
          if (methodName === 'toFixed') {
            const digits = node.arguments[0]?.value ?? 0
            // In SQL: ROUND(value, digits)
            return `ROUND(${objectExpr}, ${digits})`
          }
          if (methodName === 'toString') {
            // Cast number to text
            return `CAST(${objectExpr} AS TEXT)`
          }

          // --- Date methods ---
          if (methodName === 'getFullYear') {
            return `EXTRACT(YEAR FROM ${objectExpr})`
          }
          if (methodName === 'getMonth') {
            // JS months are 0-based, SQL is 1-based, so subtract 1
            return `(EXTRACT(MONTH FROM ${objectExpr}) - 1)`
          }
          if (methodName === 'getDate') {
            return `EXTRACT(DAY FROM ${objectExpr})`
          }
          if (methodName === 'getHours') {
            return `EXTRACT(HOUR FROM ${objectExpr})`
          }
          if (methodName === 'getMinutes') {
            return `EXTRACT(MINUTE FROM ${objectExpr})`
          }
          if (methodName === 'getSeconds') {
            return `EXTRACT(SECOND FROM ${objectExpr})`
          }

          // --- Array methods ---
          if (methodName === 'includes') {
            // Example: someArray.includes(value) -> value = ANY(array)
            // But if objectExpr is an array literal or column
            const arg = node.arguments[0]
            if (arg) {
              const valueExpr = exprToString(arg, scope)
              // Assuming objectExpr is an array column or literal
              return `${valueExpr} = ANY(${objectExpr})`
            }
          }
        }
      }
      case 'LogicalExpression': {
        const left = exprToString(node.left, scope)
        const right = exprToString(node.right, scope)
        const operator = node.operator === '&&' ? 'AND' : node.operator === '||' ? 'OR' : null
        if (!operator) throw new Error(`Unsupported logical operator: ${node.operator}`)
        return `(${left} ${operator} ${right})`
      }
      case 'BinaryExpression': {
        const left = exprToString(node.left, scope)
        const right = exprToString(node.right, scope)
        const op = node.operator

        switch (op) {
          case '==':
            return `${left} = ${right}`
          case '!=':
            return `${left} <> ${right}`
          case '>':
          case '<':
          case '>=':
          case '<=':
            return `${left} ${op} ${right}`
          case '+': {
            const leftExpr = `(${left})`
            const rightExpr = `(${right})`

            const isDefinitelyNumber =
              node.left.type === 'Literal' &&
              typeof node.left.value === 'number' &&
              node.right.type === 'Literal' &&
              typeof node.right.value === 'number'

            if (isDefinitelyNumber) {
              return `${leftExpr} + ${rightExpr}`
            }

            // Default to string concat
            return `${leftExpr}::text || ${rightExpr}::text`
          }
          case '-':
          case '*':
          case '/':
          case '%':
            return `(${left} ${op} ${right})`
          default:
            throw new Error(`Unsupported binary operator: ${op}`)
        }
      }
      case 'TemplateLiteral': {
        const parts: string[] = []

        for (let i = 0; i < node.quasis.length; i++) {
          const raw = node.quasis[i].value.raw.replace(/'/g, "''")
          if (raw.length > 0) {
            parts.push(`'${raw}'`)
          }

          const expr = node.expressions[i]
          if (expr) {
            const exprSql = exprToString(expr, scope)
            parts.push(`(${exprSql})::text`)
          }
        }

        return parts.join(' || ')
      }
      case 'MemberExpression': {
        // Handle nested member expressions, e.g. u.courses.meta.id
        let objectStr = ''
        if (node.object.type === 'Identifier') {
          const objName = node.object.name
          const propName = node.property.name || node.property.value
          if (scope[objName] !== undefined) {
            objectStr = scope[objName] ? `${scope[objName]}.${propName}` : propName
          } else {
            objectStr = `${objName}.${propName}`
          }
        } else {
          // For nested member expression like (a.b).c
          objectStr = exprToString(node.object, scope) + '.' + (node.property.name || node.property.value)
        }
        return fieldResolver(objectStr)
      }

      case 'Identifier': {
        // Variable: look up in scope
        const name = node.name
        if (scope[name] !== undefined) {
          return fieldResolver(scope[name] || name)
        }
        return fieldResolver(scope[name] || name) //return name
      }

      case 'Literal': {
        // Number or string literal
        return node.raw
      }
      case 'CallExpression': {
        // For .map calls handled in main function, just return something simple
        // or you can extend if needed
        return '[CallExpression]'
      }

      case 'ObjectExpression': {
        // For nested objects, call extractMapping to handle properly
        return JSON.stringify(extractMapping(node, scope))
      }

      default:
        return '[Unsupported Expression]'
    }
  }

  function extractMapping(node: any, scope: Record<string, any>): any {
    if (node.type === 'ObjectExpression') {
      const obj: Record<string, any> = {}

      for (const prop of node.properties) {
        const key = prop.key.name || prop.key.value
        const val = prop.value

        if (
          val.type === 'CallExpression' &&
          val.callee.type === 'MemberExpression' &&
          val.callee.property.name === 'map'
        ) {
          const arrObj = val.callee.object // e.g. u.courses or c.meta
          let objectPath = ''

          if (arrObj.type === 'MemberExpression') {
            const objName = arrObj.object.name
            const propName = arrObj.property.name
            objectPath = objName in scope ? (scope[objName] ? `${scope[objName]}.${propName}` : propName) : propName
          }

          const innerFn = val.arguments[0]
          const innerParam = innerFn.params[0].name
          const innerScope = { ...scope, [innerParam]: objectPath }

          obj[key] = extractMapping(innerFn.body, innerScope)
        } else {
          obj[key] = exprToString(val, scope)
        }
      }

      return obj
    }

    return null
  }

  let finalResult: any = null

  walk.full(ast, (node) => {
    if (node.type === 'ArrowFunctionExpression') {
      const paramName = (node as any).params[0].name
      const initialScope = {
        [paramName]: '',
      } as Record<string, any>
      finalResult = extractMapping((node as any).body, initialScope)
    }
  })

  const flattenFinalResul = flatten(finalResult)
  return Object.entries(flattenFinalResul as object).map(([alias, target]) => ({ alias, target }))
}

function parseFilter(filterSource: string, selects: { target: string; alias: string }[]): string {
  const ast = acorn.parse(filterSource, { ecmaVersion: 'latest' }) as any
  // The predicate function body expression: e.g. u.role == 'generic' && u.foo.uname.startsWith('Diana')
  const expr = ast.body[0].expression.body

  function fieldResolver(path: string): string {
    const target = selects.find((item) => item.alias === path)
    if (!target) return '[Unknown target]'
    return target.target
  }

  function exprToString(node: any, scope: Record<string, string>): string {
    switch (node.type) {
      case 'CallExpression': {
        const callee = node.callee

        if (callee.type === 'MemberExpression') {
          const methodName = callee.property.name
          const objectExpr = exprToString(callee.object, scope)

          // --- String methods ---
          if (methodName === 'toLowerCase') {
            return `LOWER(${objectExpr})`
          }
          if (methodName === 'toUpperCase') {
            return `UPPER(${objectExpr})`
          }
          if (methodName === 'trim') {
            return `TRIM(${objectExpr})`
          }
          if (methodName === 'substring') {
            const args = node.arguments
            const start = args[0]?.value ?? 0
            const length = args[1]?.value ?? null
            if (length !== null) {
              return `SUBSTRING(${objectExpr} FROM ${start + 1} FOR ${length})`
            } else {
              return `SUBSTRING(${objectExpr} FROM ${start + 1})`
            }
          }
          if (methodName === 'includes') {
            const arg = node.arguments[0]
            if (arg.type === 'Literal' && typeof arg.value === 'string') {
              // string includes: LIKE %value%
              return `${objectExpr} LIKE '%${arg.value}%'`
            } else {
              // Could be array includes, see below
            }
          }
          if (methodName === 'startsWith') {
            const prefix = node.arguments[0]?.value
            return `${objectExpr} LIKE '${prefix}%'`
          }
          if (methodName === 'endsWith') {
            const suffix = node.arguments[0]?.value
            return `${objectExpr} LIKE '%${suffix}'`
          }
          if (methodName === 'replace') {
            const search = node.arguments[0]?.value
            const replacement = node.arguments[1]?.value
            return `REPLACE(${objectExpr}, '${search}', '${replacement}')`
          }

          // --- Number methods ---
          if (methodName === 'toFixed') {
            const digits = node.arguments[0]?.value ?? 0
            // In SQL: ROUND(value, digits)
            return `ROUND(${objectExpr}, ${digits})`
          }
          if (methodName === 'toString') {
            // Cast number to text
            return `CAST(${objectExpr} AS TEXT)`
          }

          // --- Date methods ---
          if (methodName === 'getFullYear') {
            return `EXTRACT(YEAR FROM ${objectExpr})`
          }
          if (methodName === 'getMonth') {
            // JS months are 0-based, SQL is 1-based, so subtract 1
            return `(EXTRACT(MONTH FROM ${objectExpr}) - 1)`
          }
          if (methodName === 'getDate') {
            return `EXTRACT(DAY FROM ${objectExpr})`
          }
          if (methodName === 'getHours') {
            return `EXTRACT(HOUR FROM ${objectExpr})`
          }
          if (methodName === 'getMinutes') {
            return `EXTRACT(MINUTE FROM ${objectExpr})`
          }
          if (methodName === 'getSeconds') {
            return `EXTRACT(SECOND FROM ${objectExpr})`
          }

          // --- Array methods ---
          if (methodName === 'includes') {
            const arg = node.arguments[0]
            const calleeObj = callee.object

            if (calleeObj.type === 'ArrayExpression') {
              // Case: ['admin', 'mod'].includes(u.role)
              const arrayValues = calleeObj.elements.map((el: any) => {
                if (el.type === 'Literal') {
                  return typeof el.value === 'string' ? `'${el.value}'` : el.value
                } else {
                  throw new Error('Only literal values supported in array.includes')
                }
              })

              const argExpr = exprToString(arg, scope)
              return `${argExpr} = ANY(ARRAY[${arrayValues.join(', ')}])`
            }
            if (calleeObj.type === 'Identifier') {
              const arrayName = calleeObj.name

              // Scope-aware array includes: someArray.includes(u.role)
              if (arg && arg.type) {
                const valueExpr = exprToString(arg, scope)

                if (Array.isArray(scope[arrayName])) {
                  // Compile-time constant array (e.g. scope = { someArray: ['admin', 'mod'] })
                  const inList = scope[arrayName]
                    .map((val: string | number) => (typeof val === 'string' ? `'${val}'` : val))
                    .join(', ')
                  return `${valueExpr} IN (${inList})`
                }

                // Assume it's a SQL array column: u.role = ANY(someArray)
                return `${valueExpr} = ANY(${arrayName})`
              }
            }

            // string.includes('text') style
            if (arg?.type === 'Literal' && typeof arg.value === 'string') {
              return `${objectExpr} LIKE '%${arg.value}%'`
            }
          }
        }
      }
      case 'LogicalExpression': {
        const left = exprToString(node.left, scope)
        const right = exprToString(node.right, scope)
        const operator = node.operator === '&&' ? 'AND' : node.operator === '||' ? 'OR' : null
        if (!operator) throw new Error(`Unsupported logical operator: ${node.operator}`)
        return `(${left} ${operator} ${right})`
      }
      case 'BinaryExpression': {
        const left = exprToString(node.left, scope)
        const right = exprToString(node.right, scope)
        const op = node.operator

        switch (op) {
          case '==':
            return `${left} = ${right}`
          case '!=':
            return `${left} <> ${right}`
          case '>':
          case '<':
          case '>=':
          case '<=':
            return `${left} ${op} ${right}`
          case '+': {
            const leftExpr = `(${left})`
            const rightExpr = `(${right})`

            const isDefinitelyNumber =
              node.left.type === 'Literal' &&
              typeof node.left.value === 'number' &&
              node.right.type === 'Literal' &&
              typeof node.right.value === 'number'

            if (isDefinitelyNumber) {
              return `${leftExpr} + ${rightExpr}`
            }

            // Default to string concat
            return `${leftExpr}::text || ${rightExpr}::text`
          }
          case '-':
          case '*':
          case '/':
          case '%':
            return `(${left} ${op} ${right})`
          default:
            throw new Error(`Unsupported binary operator: ${op}`)
        }
      }
      case 'TemplateLiteral': {
        const parts: string[] = []

        for (let i = 0; i < node.quasis.length; i++) {
          const raw = node.quasis[i].value.raw.replace(/'/g, "''")
          if (raw.length > 0) {
            parts.push(`'${raw}'`)
          }

          const expr = node.expressions[i]
          if (expr) {
            const exprSql = exprToString(expr, scope)
            parts.push(`(${exprSql})::text`)
          }
        }

        return parts.join(' || ')
      }
      case 'MemberExpression': {
        // Handle nested member expressions, e.g. u.courses.meta.id
        let objectStr = ''
        if (node.object.type === 'Identifier') {
          const objName = node.object.name
          const propName = node.property.name || node.property.value
          if (scope[objName] !== undefined) {
            objectStr = scope[objName] ? `${scope[objName]}.${propName}` : propName
          } else {
            objectStr = `${propName}` //`${objName}.${propName}`
          }
        } else {
          // For nested member expression like (a.b).c
          objectStr = exprToString(node.object, scope) + '.' + (node.property.name || node.property.value)
        }
        return fieldResolver(objectStr)
      }

      case 'Identifier': {
        // Variable: look up in scope
        const name = node.name
        if (scope[name] !== undefined) {
          return fieldResolver(scope[name] || name)
        }
        return name
      }

      case 'Literal': {
        // Number or string literal
        return node.raw
      }
      case 'CallExpression': {
        // For .map calls handled in main function, just return something simple
        // or you can extend if needed
        return '[CallExpression]'
      }

      case 'ObjectExpression': {
        // For nested objects, call extractMapping to handle properly
        return JSON.stringify(exprToString(node, scope))
      }

      default:
        return '[Unsupported Expression]'
    }
  }

  return exprToString(expr, {})
}

function parseOrderSelector(source: string): string {
  const ast = acorn.parse(source, { ecmaVersion: 'latest' }) as any

  // Only support (x) => x.foo.bar or direct x => x.prop usage
  const body = ast.body[0].expression.body

  function extractPath(node: any): string {
    if (node.type === 'MemberExpression') {
      const parent = extractPath(node.object)
      const property = node.property.name || node.property.value
      return parent ? `${parent}.${property}` : property
    }
    if (node.type === 'Identifier') {
      return '' // skip root param
    }
    throw new Error('Unsupported order selector format')
  }

  return extractPath(body)
}

interface CompiledQuery {
  /** The full SQL query string, possibly including subqueries */
  sql: string

  /** Array of parameters to safely inject into the SQL (for prepared statements) */
  params: any[]

  /** Optional alias if this query represents a subquery that will be referenced externally */
  alias?: string

  /** Optional list of column names or projections the query returns */
  columns?: string[]
}

class PostgresQueryCompiler {
  private _aliasNum = 0
  private uniqueAlias() {
    const result = this._aliasNum
    this._aliasNum++
    return `___t${result}`
  }
  constructor() {}

  compileSelectSubquery<T>(
    subquery: CompiledQuery,
    ops: QueryOperation<T>[],
    scope: Record<string, any> = {}
  ): CompiledQuery {
    let distinct = false
    let from = {} as { target: string; alias: string }
    let selects = [] as { target: string; alias: string }[]
    let joins = [] as {
      target: string
      alias: string
      type: string
      foreignKey: string
      principalKey: string
    }[]
    let wheres = [] as string[]
    let offset = 0
    let limit = 0
    // setup initial table data to include into
    from.target = `(${subquery.sql})`
    from.alias = this.uniqueAlias()
    for (const column of subquery.columns!) {
      selects.push({
        target: `"${from.alias}"."${column}"`,
        alias: column,
      })
    }

    //iterate ops
    for (const op of ops) {
      switch (op.type) {
        case 'map': {
          selects = parseProjection(op.data.toString(), selects, scope)
          break
        }
        case 'filter': {
          const where = parseFilter(op.data.toString(), selects)
          wheres.push(where)
          break
        }
        case 'distinct': {
          distinct = true
          break
        }
        case 'skip': {
          offset = op.data
          break
        }
        case 'take': {
          limit = op.data
          break
        }
      }
    }
    // Compose inner query
    let sql = ''
    let queryParts = []
    queryParts.push(distinct ? 'SELECT DISTINCT' : 'SELECT')
    queryParts.push(selects.map((select) => `${select.target} AS "${select.alias}"`).join(','))
    queryParts.push(`FROM ${from.target} AS "${from.alias}"`)
    queryParts.push(
      joins.map(
        (join) =>
          `${join.type} JOIN ${join.target} AS "${join.alias}" ON "${from.alias}"."${join.foreignKey}"="${join.alias}"."${join.principalKey}"`
      )
    )
    if (wheres.length) queryParts.push('WHERE ' + wheres.map((where) => `(${where})`).join(' AND '))
    if (offset) queryParts.push(`OFFSET ${offset}`)
    if (limit) queryParts.push(`LIMIT ${limit}`)
    sql = queryParts.join(' ')
    return {
      sql,
      params: [],
      alias: this.uniqueAlias(),
      columns: selects.map((select) => select.alias),
    }
  }
  compileSelect<T>(entityType: new () => T, ops: QueryOperation<T>[], scope: Record<string, any> = {}): CompiledQuery {
    const [firstGroup, ...otherGroups] = this.splitOps(ops)
    let compiled = this.compileSelectEntity(entityType, firstGroup, scope)
    if (otherGroups.length) {
      for (const group of otherGroups) {
        compiled = this.compileSelectSubquery(compiled, group, scope)
      }
    }
    return compiled
  }

  compileSelectEntity<T>(
    entityType: new () => T,
    ops: QueryOperation<T>[],
    scope: Record<string, any> = {}
  ): CompiledQuery {
    let distinct = false
    let from = {} as { target: string; alias: string }
    let selects = [] as { target: string; alias: string }[]
    let joins = [] as {
      target: string
      alias: string
      type: string
      foreignKey: string
      principalKey: string
    }[]
    let wheres = [] as string[]
    let offset = 0
    let limit = 0
    // setup initial table data to include into
    const tableMeta = getTableMetadata(entityType)
    const columnMeta = getColumnsMetadata(entityType)
    from.target = `"${tableMeta.name}"`
    from.alias = this.uniqueAlias()
    for (const meta of Object.values(columnMeta)) {
      selects.push({
        target: `"${from.alias}"."${meta.name}"`,
        alias: meta.fieldName,
      })
    }

    //iterate ops
    for (const op of ops) {
      switch (op.type) {
        case 'include': {
          const include = op.data
          const mainRelationMeta = getRelationsMetadata(entityType)
          //
          const joinRelationMeta = mainRelationMeta[include]
          const joinEntity = joinRelationMeta.target()
          const joinTableMeta = getTableMetadata(joinEntity)
          const joinColumnMeta = getColumnsMetadata(joinEntity)

          const joinTableAlias = `___t${joins.length + 1}`
          joins.push({
            alias: joinTableAlias,
            target: `"${joinTableMeta.name}"`,
            type: (joinRelationMeta.type || 'left').toUpperCase(),
            foreignKey: joinRelationMeta.foreignKey || '1',
            principalKey: joinRelationMeta.principalKey || '1',
          })
          for (const meta of Object.values(joinColumnMeta)) {
            const selectAlias = `${joinRelationMeta.fieldName}.${meta.fieldName}`
            const selectTarget = `"${joinTableAlias}"."${meta.name}"`
            selects.push({
              alias: selectAlias,
              target: selectTarget,
            })
          }
          break
        }
        case 'map': {
          selects = parseProjection(op.data.toString(), selects, scope)
          break
        }
        case 'filter': {
          const where = parseFilter(op.data.toString(), selects)
          wheres.push(where)
          break
        }
        case 'distinct': {
          distinct = true
          break
        }
        case 'skip': {
          offset = op.data
          break
        }
        case 'take': {
          limit = op.data
          break
        }
      }
    }
    // Compose inner query
    let sql = ''
    let queryParts = []
    queryParts.push(distinct ? 'SELECT DISTINCT' : 'SELECT')
    queryParts.push(selects.map((select) => `${select.target} AS "${select.alias}"`).join(','))
    queryParts.push(`FROM ${from.target} AS "${from.alias}"`)
    queryParts.push(
      joins.map(
        (join) =>
          `${join.type} JOIN ${join.target} AS "${join.alias}" ON "${from.alias}"."${join.foreignKey}"="${join.alias}"."${join.principalKey}"`
      )
    )
    if (wheres.length) queryParts.push('WHERE ' + wheres.map((where) => `(${where})`).join(' AND '))
    if (offset) queryParts.push(`OFFSET ${offset}`)
    if (limit) queryParts.push(`LIMIT ${limit}`)
    sql = queryParts.join(' ')
    return {
      sql,
      params: [],
      alias: this.uniqueAlias(),
      columns: selects.map((select) => select.alias),
    }
  }

  private splitOps(ops: QueryOperation<any>[]): QueryOperation<any>[][] {
    const groups: QueryOperation<any>[][] = []
    let group: QueryOperation<any>[] = []

    for (const [i, op] of Object.entries(ops)) {
      const prev = ops[+i - 1]
      if (op.type == 'map' && (prev?.type === 'skip' || prev?.type === 'take')) {
        groups.push(group)
        group = []
      }
      group.push(op)
    }

    // Push any remaining ops as last group
    if (group.length > 0) {
      groups.push(group)
    }

    return groups
  }
}

export class PostgresEngine implements IEngine {
  source: PostgresDataSource

  constructor(source: PostgresDataSource) {
    this.source = source
  }

  async toArray<T>({ entityType, ops, scope }: IQueryableState<T>): Promise<T[]> {
    const compiler = new PostgresQueryCompiler()

    const compiled = compiler.compileSelect<T>(entityType, ops, scope)

    const client = await this.source.pool.connect()
    try {
      console.log(compiled.sql)
      const result = await client.query(compiled.sql)
      console.log(JSON.stringify(result.rows))
      return result.rows.map((v) => unflatten(v))
    } finally {
      client.release()
    }
  }

  async first<T>(q: IQueryableState<T>): Promise<T | undefined> {
    q.ops.push({ type: 'take', data: 1 })
    const arr = await this.toArray(q)
    return arr[0]
  }

  async count<T>(q: IQueryable<T>): Promise<number> {
    return 0
  }
}

export class PostgresDataSource implements IDataSource {
  engine: IEngine
  pool: Pool

  constructor(connectionString: string) {
    this.engine = new PostgresEngine(this)
    this.pool = new Pool({ connectionString })
  }
}
