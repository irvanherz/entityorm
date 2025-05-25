import acorn from 'acorn'
import { IEngine } from './IEngine'
import { IQueryable, IQueryableState } from './IQueryable'
import { IDataSource } from './IDataSource'
import { Pool } from 'pg'
import { flatten, unflatten } from 'flat'
import {
    getColumnsMetadata,
    getRelationsMetadata,
    getTableMetadata,
} from './attributes'
import walk from 'acorn-walk'

export function parseProjection(
    mapper: string,
    aliasMap: { target: string; alias: string }[]
): { target: string; alias: string }[] {
    const ast = acorn.parse(mapper, { ecmaVersion: 'latest' }) as any

    function fieldResolver(path: string): string {
        const target = aliasMap.find((item) => item.alias === path)
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
                        if (
                            arg.type === 'Literal' &&
                            typeof arg.value === 'string'
                        ) {
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
                const operator =
                    node.operator === '&&'
                        ? 'AND'
                        : node.operator === '||'
                          ? 'OR'
                          : null
                if (!operator)
                    throw new Error(
                        `Unsupported logical operator: ${node.operator}`
                    )
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
                        objectStr = scope[objName]
                            ? `${scope[objName]}.${propName}`
                            : propName
                    } else {
                        objectStr = `${objName}.${propName}`
                    }
                } else {
                    // For nested member expression like (a.b).c
                    objectStr =
                        exprToString(node.object, scope) +
                        '.' +
                        (node.property.name || node.property.value)
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
                return JSON.stringify(extractMapping(node, scope))
            }

            default:
                return '[Unsupported Expression]'
        }
    }

    function extractMapping(node: any, scope: Record<string, string>): any {
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
                        objectPath =
                            objName in scope
                                ? scope[objName]
                                    ? `${scope[objName]}.${propName}`
                                    : propName
                                : propName
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
            finalResult = extractMapping((node as any).body, {
                [paramName]: '',
            })
        }
    })

    const flattenFinalResul = flatten(finalResult)
    return Object.entries(flattenFinalResul as object).map(
        ([alias, target]) => ({ alias, target })
    )
}

function parseFilter(
    filterSource: string,
    aliasMap: { target: string; alias: string }[]
): string {
    const ast = acorn.parse(filterSource, { ecmaVersion: 'latest' }) as any

    // The predicate function body expression: e.g. u.role == 'generic' && u.foo.uname.startsWith('Diana')
    const expr = ast.body[0].expression.body

    function extractExpression(node: any): string {
        switch (node.type) {
            case 'LogicalExpression': {
                const left = extractExpression(node.left)
                const right = extractExpression(node.right)
                const operator =
                    node.operator === '&&'
                        ? 'AND'
                        : node.operator === '||'
                          ? 'OR'
                          : null
                if (!operator)
                    throw new Error(
                        `Unsupported logical operator: ${node.operator}`
                    )
                return `(${left} ${operator} ${right})`
            }

            case 'BinaryExpression': {
                const left = extractExpression(node.left)
                const right = extractExpression(node.right)
                switch (node.operator) {
                    case '==':
                        return `${left} = ${right}`
                    case '!=':
                        return `${left} <> ${right}`
                    case '>':
                    case '<':
                    case '>=':
                    case '<=':
                        return `${left} ${node.operator} ${right}`
                    case '+':
                        // Possibly string concatenation -> SQL ||
                        return `(${left} || ${right})`
                    default:
                        throw new Error(
                            `Unsupported binary operator: ${node.operator}`
                        )
                }
            }

            case 'MemberExpression': {
                // Recursively build the full path, skipping root param identifier
                function buildPath(n: any): string[] {
                    if (n.type === 'MemberExpression') {
                        return [
                            ...buildPath(n.object),
                            n.property.name || n.property.value,
                        ]
                    }
                    if (n.type === 'Identifier') {
                        return [] // skip root identifier (e.g. "u")
                    }
                    throw new Error(
                        `Unsupported node in member expression: ${n.type}`
                    )
                }
                const fullPath = buildPath(node).join('.')
                if (!aliasMap.find((x) => x.alias === fullPath))
                    throw new Error('Invalid map')
                return fullPath
            }

            case 'CallExpression': {
                const callee = node.callee
                if (callee.type === 'MemberExpression') {
                    const method = callee.property.name
                    const objExpr = extractExpression(callee.object)

                    if (method === 'startsWith') {
                        // Argument assumed to be a literal string
                        const arg = node.arguments[0]
                        if (arg.type !== 'Literal')
                            throw new Error(
                                'startsWith argument must be a literal'
                            )
                        return `${objExpr} LIKE '${arg.value}%'`
                    }
                    if (method === 'endsWith') {
                        const arg = node.arguments[0]
                        if (arg.type !== 'Literal')
                            throw new Error(
                                'endsWith argument must be a literal'
                            )
                        return `${objExpr} LIKE '%${arg.value}'`
                    }
                    if (method === 'includes') {
                        const arg = node.arguments[0]
                        if (arg.type !== 'Literal')
                            throw new Error(
                                'includes argument must be a literal'
                            )
                        return `${objExpr} LIKE '%${arg.value}%'`
                    }
                    // Add more string methods as needed
                }
                throw new Error(`Unsupported call expression: ${callee.type}`)
            }

            case 'Identifier': {
                // Should never be alone in filter condition, return as is
                return `"${node.name}"`
            }

            case 'Literal': {
                if (typeof node.value === 'string') {
                    return `'${node.value.replace(/'/g, "''")}'` // escape single quotes for SQL
                }
                return node.value.toString()
            }

            default:
                throw new Error(`Unsupported node type in filter: ${node.type}`)
        }
    }

    return extractExpression(expr)
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

interface Selectable {
    target: string
    targetType: 'table' | 'expression'
    alias: string
    fields: Array<{
        target: string
        targetType: 'column' | 'expression'
        alias: string
    }>
}

export class PostgresEngine implements IEngine {
    source: PostgresDataSource

    constructor(source: PostgresDataSource) {
        this.source = source
    }

    async toArray<T>({ entityType, ops }: IQueryableState<T>): Promise<T[]> {
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
        from.alias = '___t0'
        for (const meta of Object.values(columnMeta)) {
            selects.push({
                target: `"___t0"."${meta.name}"`,
                alias: meta.fieldName,
            })
        }

        //iterate ops
        for (const op of ops) {
            switch (op.type) {
                case 'includes': {
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
                    selects = parseProjection(op.data.toString(), selects)
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
        queryParts.push(
            selects
                .map((select) => `${select.target} AS "${select.alias}"`)
                .join(',')
        )
        queryParts.push(`FROM ${from.target} AS "${from.alias}"`)
        queryParts.push(
            joins.map(
                (join) =>
                    `${join.type} JOIN ${join.target} AS "${join.alias}" ON "${from.alias}"."${join.foreignKey}"="${join.alias}"."${join.principalKey}"`
            )
        )
        queryParts = [`SELECT * FROM (${queryParts.join(' ')}) AS "___sub"`]
        if (wheres.length)
            queryParts.push(
                'WHERE ' + wheres.map((where) => `(${where})`).join(' AND ')
            )
        if (offset) queryParts.push(`OFFSET ${offset}`)
        if (limit) queryParts.push(`LIMIT ${limit}`)
        sql = queryParts.join(' ')

        const client = await this.source.pool.connect()
        try {
            console.log(sql)
            const result = await client.query(sql)
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
