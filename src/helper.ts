/** Public query column names, including nested relation paths. */
export type Column<T> = Extract<keyof T, string> | (string & Record<never, never>)
export type SortBy<T> = [Column<T> | Column<T>[], 'ASC' | 'DESC'][]
export type MappedColumns<T, V> = Record<Column<T>, V>
export type RelationSchemaInput<T> = string[] | Partial<Record<Extract<keyof T, string>, unknown>>
export type JoinMethod = 'leftJoinAndSelect' | 'innerJoinAndSelect'

export const isNil = (value: unknown): value is null | undefined => value === null || value === undefined

export function positiveNumberOrDefault(value: number | undefined, fallback: number, minimum = 1): number {
    return Number.isFinite(value) && value! >= minimum ? value! : fallback
}

export function relationPaths(relations?: string[] | Record<string, unknown>): string[] {
    if (!relations) return []
    if (Array.isArray(relations)) return relations
    const result: string[] = []
    const visit = (node: Record<string, unknown>, prefix = '') => {
        for (const [key, value] of Object.entries(node)) {
            const path = prefix ? `${prefix}.${key}` : key
            if (value === true) result.push(path)
            else if (value && typeof value === 'object') visit(value as Record<string, unknown>, path)
        }
    }
    visit(relations)
    return result
}
