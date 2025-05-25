interface TableOptions {
    name: string
}

interface TableMeta extends TableOptions {
    className: string
}

const TABLE_METADATA_KEY = Symbol('entityorm:table')

export function Table(options: TableOptions = { name: null! }) {
    return function (target: Function) {
        const className = target.name
        const tableName = options.name || className.toLowerCase() // Default to class name in lowercase
        Reflect.defineMetadata(
            TABLE_METADATA_KEY,
            { name: tableName, className } as TableMeta,
            target
        )
    }
}

// Utility function to retrieve table metadata
export function getTableMetadata(target: Function): TableMeta {
    return Reflect.getMetadata(TABLE_METADATA_KEY, target)
}

// Utility function to retrieve column metadata
export function getColumnsMetadata(
    target: Function
): Record<string, ColumnMeta> {
    return Reflect.getMetadata(COLUMN_METADATA_KEY, target) || {}
}

export function getRelationsMetadata<T extends () => Function>(
    target: Function
): Record<string, RelationMeta<T>> {
    return Reflect.getMetadata(RELATION_METADATA_KEY, target) || []
}

interface RelationOptions {
    cascade?:
        | boolean
        | Array<'insert' | 'update' | 'remove' | 'soft-remove' | 'recover'>
    eager?: boolean
    type?: 'left' | 'inner' | 'right'
    foreignKey?: string
    principalKey?: string
    nullable?: boolean
}

interface RelationMeta<T extends () => Function> extends RelationOptions {
    target: T
    fieldName: string
}

const RELATION_METADATA_KEY = Symbol('entityorm:relation')

export function HasMany(target: () => Function, options: RelationOptions = {}) {
    return function (targetPrototype: Object, propertyKey: string | symbol) {
        const existingMetadata: Record<
            string,
            RelationMeta<() => Function>
        > = Reflect.getMetadata(
            RELATION_METADATA_KEY,
            targetPrototype.constructor
        ) || {}

        existingMetadata[propertyKey.toString()] = {
            ...options,
            fieldName: propertyKey.toString(),
            target: target,
        }

        Reflect.defineMetadata(
            RELATION_METADATA_KEY,
            existingMetadata,
            targetPrototype.constructor
        )
    }
}

interface ColumnOptions {
    name: string
    type?: string
    nullable?: boolean
    default?: any
    unique?: boolean
    primary?: boolean
    length?: number
}

interface ColumnMeta extends ColumnOptions {
    fieldName: string
}

const COLUMN_METADATA_KEY = Symbol('entityorm:column')

export function Column(options: ColumnOptions = { name: null! }) {
    return function (targetPrototype: Object, propertyKey: string | symbol) {
        const existingMetadata: Record<string, ColumnMeta> =
            Reflect.getMetadata(
                COLUMN_METADATA_KEY,
                targetPrototype.constructor
            ) || {}

        const fieldName = propertyKey.toString()
        const columnName = options.name || fieldName
        existingMetadata[propertyKey.toString()] = {
            ...options,
            name: columnName,
            fieldName,
        }

        Reflect.defineMetadata(
            COLUMN_METADATA_KEY,
            existingMetadata,
            targetPrototype.constructor
        )
    }
}

export function getColumnMeta(target: Function): Record<string, ColumnMeta> {
    return Reflect.getMetadata(COLUMN_METADATA_KEY, target) || {}
}

function extractPropertyNameProxy<T>(fn: (obj: T) => any): string {
    const fnStr = fn.toString()
    const match = fnStr.match(/=>\s*\w+\.(\w+)/)
    if (!match)
        throw new Error('Only arrow functions like "x => x.prop" are supported')
    return match[1]
}

function getRelationMetaFromSelector<T>(
    model: new () => T,
    selector: (obj: T) => any
): RelationMeta<() => Function> | undefined {
    const field = extractPropertyNameProxy(selector)
    const all: Record<
        string,
        RelationMeta<() => Function>
    > = Reflect.getMetadata(RELATION_METADATA_KEY, model) || {}
    return all[field]
}
