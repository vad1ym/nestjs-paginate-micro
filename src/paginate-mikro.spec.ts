import { Collection, EntitySchema, raw } from '@mikro-orm/core'
import { MikroORM } from '@mikro-orm/sqlite'
import type { EntityRepository, SelectQueryBuilder } from '@mikro-orm/postgresql'
import { FilterOperator, FilterQuantifier, paginate, PaginateConfig, PaginationType } from './paginate'

class Doctor {
    id!: number
    publicId!: string
    firstName!: string
    lastName!: string
    verificationStatus!: string
    createdAt!: Date
    profileData!: { tier: string }
    nickname?: string | null
    normalizedLastName?: string
    openingDate!: string
    licenses = new Collection<License>(this)
}

class License {
    id!: number
    doctor!: Doctor
    country!: string
}

const DoctorSchema = new EntitySchema<Doctor>({
    class: Doctor,
    properties: {
        id: { type: 'number', primary: true },
        publicId: { type: 'uuid', unique: true },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        verificationStatus: { type: 'string', enum: true, items: ['pending', 'verified', 'rejected'] },
        createdAt: { type: 'Date' },
        profileData: { type: 'json' },
        nickname: { type: 'string', nullable: true },
        normalizedLastName: { type: 'string', formula: 'lower(last_name)' },
        openingDate: { type: 'date' },
        licenses: { kind: '1:m', entity: () => License, mappedBy: 'doctor' },
    },
})
const LicenseSchema = new EntitySchema<License>({
    class: License,
    properties: {
        id: { type: 'number', primary: true },
        doctor: { kind: 'm:1', entity: () => Doctor },
        country: { type: 'string' },
    },
})

const config: PaginateConfig<Doctor> = {
    sortableColumns: ['createdAt', 'lastName', 'id'],
    searchableColumns: ['firstName', 'lastName'],
    filterableColumns: {
        verificationStatus: ['$in'],
        id: ['$gt'],
    },
    defaultSortBy: [
        ['createdAt', 'DESC'],
        ['id', 'DESC'],
    ],
}

describe('MikroORM pagination', () => {
    let orm: any

    beforeAll(async () => {
        orm = await MikroORM.init({
            dbName: ':memory:',
            entities: [DoctorSchema, LicenseSchema],
            allowGlobalContext: true,
        })
        if (orm.schema?.create) await orm.schema.create()
        else await orm.getSchemaGenerator().createSchema()
        const rows = [
            [1, 'Alice', 'Adams', 'pending'],
            [2, 'Bob', 'Brown', 'verified'],
            [3, 'Alice', 'Clark', 'pending'],
            [4, 'Diana', 'Dover', 'rejected'],
        ] as const
        const doctors: Doctor[] = []
        for (const [id, firstName, lastName, verificationStatus] of rows) {
            doctors.push(
                orm.em.create(Doctor, {
                    id,
                    publicId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
                    firstName,
                    lastName,
                    verificationStatus,
                    createdAt: new Date(`2026-01-0${id}`),
                    profileData: { tier: id % 2 === 0 ? 'pro' : 'free' },
                    nickname: id === 2 ? 'A' : id === 4 ? 'Z' : null,
                    openingDate: `2026-01-0${id}`,
                })
            )
        }
        orm.em.create(License, { id: 1, doctor: doctors[3], country: 'ES' })
        orm.em.create(License, { id: 2, doctor: doctors[3], country: 'FR' })
        await orm.em.flush()
        orm.em.clear()
    })

    afterAll(async () => {
        await orm.close()
    })

    it('keeps offset totals, filters and links', async () => {
        const result = await paginate<Doctor>(
            {
                page: 1,
                limit: 1,
                search: 'Alice',
                filter: { verificationStatus: 'pending' },
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual([3])
        expect(result.meta.totalItems).toBe(2)
        expect(result.meta.totalPages).toBe(2)
        expect(result.links.next).toContain('page=2')
        expect(result.links.next).toContain('filter.verificationStatus=pending')
    })

    it('supports filter expressions and rejects disallowed fields', async () => {
        const result = await paginate<Doctor>(
            {
                filterExpression: 'verificationStatus=$eq:pending OR verificationStatus=$eq:verified',
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.meta.totalItems).toBe(3)
        expect(result.links.current).toContain('filter=')
        await expect(
            paginate(
                {
                    filterExpression: 'firstName=$eq:Alice',
                    path: 'http://localhost/admin/doctors',
                },
                orm.em.getRepository(Doctor),
                config
            )
        ).rejects.toThrow()
    })

    it('rejects expression filters for resolver fields outside the allow-list', async () => {
        const resolver = vi.fn(() => raw('first_name'))
        await expect(
            paginate({ path: null, filterExpression: 'firstName=$eq:Alice' }, orm.em.getRepository(Doctor), {
                ...config,
                fieldResolvers: { firstName: resolver },
            })
        ).rejects.toThrow("Column 'firstName' is not filterable")
        expect(resolver).not.toHaveBeenCalled()
    })

    it.each([
        ['$eq:2026-01-02', [2]],
        ['$btw:2026-01-02,2026-01-03', [3, 2]],
        ['$in:2026-01-01,2026-01-03', [3, 1]],
    ])('preserves typed date values in resolved filters: %s', async (value, ids) => {
        const result = await paginate({ path: null, filter: { createdAt: value } }, orm.em.getRepository(Doctor), {
            ...config,
            filterableColumns: { createdAt: true },
            fieldResolvers: { createdAt: { filter: () => raw((alias) => `${alias}.created_at`) } },
        })
        expect(result.data.map((row) => row.id)).toEqual(ids)
    })

    it('supports MikroORM cursor pages', async () => {
        const result = await paginate<Doctor>(
            {
                limit: 2,
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, paginationType: PaginationType.CURSOR }
        )
        expect(result.data).toHaveLength(2)
        expect(result.links.next).toContain('cursor=')
        const cursor = new URL(result.links.next!).searchParams.get('cursor')!
        const second = await paginate<Doctor>(
            {
                limit: 2,
                cursor,
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, paginationType: PaginationType.CURSOR }
        )
        expect(second.data.map((row) => row.id)).toEqual([2, 1])
        const previous = new URL(second.links.previous!).searchParams.get('cursor')!
        const firstAgain = await paginate<Doctor>(
            {
                limit: 2,
                cursor: previous,
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, paginationType: PaginationType.CURSOR }
        )
        expect(firstAgain.data.map((row) => row.id)).toEqual([4, 3])
    })

    it('keeps searchBy and select in cursor links', async () => {
        const result = await paginate<Doctor>(
            {
                limit: 1,
                search: 'Alice',
                searchBy: ['firstName'],
                select: ['firstName'],
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, paginationType: PaginationType.CURSOR, select: ['id', 'firstName', 'createdAt'] }
        )
        expect(result.links.next).toContain('searchBy=firstName')
        expect(result.links.next).toContain('select=firstName')
        expect(result.meta.select).toEqual(['firstName'])
    })

    it('converts numeric filter values from entity metadata', async () => {
        const result = await paginate<Doctor>(
            {
                filter: { id: '$gt:2' },
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual([4, 3])
    })

    it('rejects invalid direct pagination numbers', async () => {
        const repo = orm.em.getRepository(Doctor)
        await expect(paginate<Doctor>({ page: 0, path: null }, repo, config)).rejects.toThrow('Invalid page')
        await expect(paginate<Doctor>({ limit: 1.5, path: null }, repo, config)).rejects.toThrow('Invalid limit')
        await expect(
            paginate<Doctor>({ limit: 0, path: null }, repo, { ...config, paginationType: PaginationType.CURSOR })
        ).rejects.toThrow('Cursor pagination requires a positive limit')
    })

    it('validates enum values from entity metadata', async () => {
        const repo = orm.em.getRepository(Doctor)
        const allowed = { ...config, throwOnInvalidFilter: true }
        const valid = await paginate<Doctor>(
            { filter: { verificationStatus: 'pending' }, path: 'http://localhost/doctors' },
            repo,
            allowed
        )
        expect(valid.data.map((row) => row.id)).toEqual([3, 1])
        await expect(
            paginate<Doctor>(
                { filter: { verificationStatus: 'unknown' }, path: 'http://localhost/doctors' },
                repo,
                allowed
            )
        ).rejects.toThrow('Invalid enum filter value')
    })

    it('validates UUID and date-only fields from entity metadata', async () => {
        const repo = orm.em.getRepository(Doctor)
        const allowed: PaginateConfig<Doctor> = {
            ...config,
            throwOnInvalidFilter: true,
            filterableColumns: { publicId: true, openingDate: true },
        }
        const result = await paginate<Doctor>(
            { filter: { publicId: '00000000-0000-4000-8000-000000000002' }, path: 'http://localhost/doctors' },
            repo,
            allowed
        )
        expect(result.data.map((row) => row.id)).toEqual([2])
        await expect(
            paginate<Doctor>({ filter: { publicId: 'not-a-uuid' }, path: 'http://localhost/doctors' }, repo, allowed)
        ).rejects.toThrow('Invalid UUID filter value')
        await expect(
            paginate<Doctor>({ filter: { openingDate: '2026-02-30' }, path: 'http://localhost/doctors' }, repo, allowed)
        ).rejects.toThrow('Invalid date filter value')
    })

    it('filters a JSON property path', async () => {
        const result = await paginate<Doctor>(
            { filter: { 'profileData.tier': 'pro' }, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, filterableColumns: { 'profileData.tier': true } }
        )
        expect(result.data.map((row) => row.id)).toEqual([4, 2])
    })

    it('sorts by a JSON property path', async () => {
        const result = await paginate<Doctor>(
            { sortBy: [['profileData.tier', 'ASC']], path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, sortableColumns: [...config.sortableColumns, 'profileData.tier'] }
        )
        expect(result.data.map((row) => row.id)).toEqual([1, 3, 2, 4])
    })

    it('filters, sorts and selects a MikroORM formula property', async () => {
        const formulaConfig: PaginateConfig<Doctor> = {
            ...config,
            sortableColumns: [...config.sortableColumns, 'normalizedLastName'],
            filterableColumns: { normalizedLastName: true },
            select: ['id', 'normalizedLastName'],
        }
        const result = await paginate<Doctor>(
            {
                filter: { normalizedLastName: 'adams' },
                sortBy: [['normalizedLastName', 'ASC']],
                select: ['normalizedLastName'],
                path: 'http://localhost/articles',
            },
            orm.em.getRepository(Doctor),
            formulaConfig
        )
        expect(result.data.map((row) => row.id)).toEqual([1])
        expect(result.data[0].normalizedLastName).toBe('adams')
    })

    it('sorts by the first non-null polymorphic value', async () => {
        const result = await paginate<Doctor>(
            { sortBy: [[['nickname', 'lastName'], 'ASC']], limit: 2, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, sortableColumns: [...config.sortableColumns, 'nickname'] }
        )
        expect(result.data.map((row) => row.id)).toEqual([2, 1])
        expect(new URL(result.links.next!).searchParams.get('sortBy')).toBe('nickname~lastName:ASC')
    })

    it('filters polymorphic values in parameters and expressions', async () => {
        const polymorphicConfig: PaginateConfig<Doctor> = {
            ...config,
            filterableColumns: { nickname: true, lastName: true },
        }
        const repository = orm.em.getRepository(Doctor)
        const direct = await paginate<Doctor>(
            { filter: { 'nickname~lastName': 'Adams' }, path: 'http://localhost/articles' },
            repository,
            polymorphicConfig
        )
        expect(direct.data.map((row) => row.id)).toEqual([1])

        const expression = await paginate<Doctor>(
            { filterExpression: 'nickname~lastName=$eq:A', path: 'http://localhost/articles' },
            repository,
            polymorphicConfig
        )
        expect(expression.data.map((row) => row.id)).toEqual([2])
    })

    it('uses to-one joins in polymorphic filters', async () => {
        const result = await paginate<License>(
            { filter: { 'doctor.nickname~country': 'Z' }, path: 'http://localhost/licenses' },
            orm.em.getRepository(License),
            { sortableColumns: ['id'], filterableColumns: { 'doctor.nickname': true, country: true } }
        )
        expect(result.data.map((row) => row.id)).toEqual([1, 2])
    })

    it('sorts by a JSON path behind a to-one relation', async () => {
        const result = await paginate<License>(
            { sortBy: [['doctor.profileData.tier', 'ASC']], path: 'http://localhost/licenses' },
            orm.em.getRepository(License),
            { sortableColumns: ['id', 'doctor.profileData.tier'] }
        )
        expect(result.data.map((row) => row.id)).toEqual([1, 2])
    })

    it('searches a JSON property path', async () => {
        const result = await paginate<Doctor>(
            { search: 'pro', path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, searchableColumns: ['profileData.tier'] }
        )
        expect(result.data.map((row) => row.id)).toEqual([4, 2])
    })

    it('places nulls last when requested', async () => {
        const result = await paginate<Doctor>(
            { sortBy: [['nickname', 'ASC']], path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, sortableColumns: [...config.sortableColumns, 'nickname'], nullSort: 'last' }
        )
        expect(result.data.map((row) => row.id)).toEqual([2, 4, 1, 3])
    })

    it('combines repeated filters with the requested comparator', async () => {
        const result = await paginate<Doctor>(
            {
                filter: { verificationStatus: ['pending', '$or:$eq:verified'] },
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, throwOnInvalidFilter: true }
        )
        expect(result.meta.totalItems).toBe(3)
    })

    it('accepts a MikroORM query builder with its own scope', async () => {
        const builder: SelectQueryBuilder<Doctor> = orm.em
            .createQueryBuilder(Doctor, 'doctor')
            .where({ verificationStatus: 'pending' })
        const result = await paginate<Doctor>(
            {
                limit: 1,
                path: 'http://localhost/admin/doctors',
            },
            builder,
            config
        )
        expect(result.meta.totalItems).toBe(2)
        expect(result.data.map((row) => row.id)).toEqual([3])
    })

    it('intersects wildcard selections and keeps the primary key', async () => {
        orm.em.clear()
        const result = await paginate<Doctor>(
            { select: ['lastName'], path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, select: ['*'] }
        )
        expect(result.data[0].id).toBe(4)
        expect(result.data[0].lastName).toBe('Dover')
        expect(result.data[0].firstName).toBeUndefined()
        expect(result.meta.select).toEqual(['lastName'])
    })

    it('applies selection to query builders too', async () => {
        orm.em.clear()
        const builder: SelectQueryBuilder<Doctor> = orm.em.createQueryBuilder(Doctor, 'doctor')
        const result = await paginate<Doctor>(
            { select: ['lastName'], path: 'http://localhost/admin/doctors' },
            builder,
            { ...config, select: ['id', 'lastName', 'firstName'] }
        )
        expect(result.data[0].id).toBe(4)
        expect(result.data[0].lastName).toBe('Dover')
        expect(result.data[0].firstName).toBeUndefined()
    })

    it('uses a separate repository count when optimizedCount is enabled', async () => {
        const result = await paginate<Doctor>(
            { limit: 1, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, optimizedCount: true }
        )
        expect(result.data.map((row) => row.id)).toEqual([4])
        expect(result.meta.totalItems).toBe(4)
    })

    it('uses a cloned query builder for custom count', async () => {
        const builder: SelectQueryBuilder<Doctor> = orm.em
            .createQueryBuilder(Doctor, 'doctor')
            .where({ verificationStatus: 'pending' })
        const result = await paginate<Doctor>({ limit: 1, path: 'http://localhost/admin/doctors' }, builder, {
            ...config,
            buildCountQuery: (qb) => qb,
        })
        expect(result.data.map((row) => row.id)).toEqual([3])
        expect(result.meta.totalItems).toBe(2)
    })

    it('accepts a MikroORM count callback for repositories', async () => {
        const result = await paginate<Doctor>(
            { limit: 1, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, buildCountQuery: (qb) => qb }
        )
        expect(result.data.map((row) => row.id)).toEqual([4])
        expect(result.meta.totalItems).toBe(4)
    })

    it('loads collections without multiplying root page rows or total', async () => {
        const doctors: EntityRepository<Doctor> = orm.em.getRepository(Doctor)
        const result = await paginate<Doctor>(
            {
                limit: 1,
                path: 'http://localhost/admin/doctors',
            },
            doctors,
            { ...config, relations: { licenses: true } }
        )
        expect(result.meta.totalItems).toBe(4)
        expect(result.data).toHaveLength(1)
        expect(result.data[0].licenses.getItems()).toHaveLength(2)
    })

    it.each([
        ['$any:$eq:FR', [4]],
        ['$none:$eq:FR', [3, 2, 1]],
        ['$all:$eq:ES', []],
    ])('applies relation quantifier %s', async (filter, ids) => {
        const result = await paginate<Doctor>(
            { filter: { 'licenses.country': filter }, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            {
                ...config,
                filterableColumns: {
                    ...config.filterableColumns,
                    'licenses.country': [
                        FilterOperator.EQ,
                        FilterQuantifier.ANY,
                        FilterQuantifier.ALL,
                        FilterQuantifier.NONE,
                    ],
                },
            }
        )
        expect(result.data.map((row) => row.id)).toEqual(ids)
    })

    it('keeps relation leaves independent in boolean expressions', async () => {
        const result = await paginate<Doctor>(
            {
                filterExpression: 'licenses.country=$eq:ES AND licenses.country=$eq:FR',
                path: 'http://localhost/admin/doctors',
            },
            orm.em.getRepository(Doctor),
            { ...config, filterableColumns: { 'licenses.country': true } }
        )
        expect(result.data.map((row) => row.id)).toEqual([4])
    })

    it.each([
        [1, 2, [4, 3], 2],
        [2, 2, [2, 1], 2],
        [9, 2, [], 2],
    ])('paginates page %i with limit %i', async (page, limit, ids, totalPages) => {
        const result = await paginate<Doctor>(
            { page, limit, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual(ids)
        expect(result.meta.totalItems).toBe(4)
        expect(result.meta.totalPages).toBe(totalPages)
    })

    it('caps a requested limit to maxLimit', async () => {
        const result = await paginate<Doctor>(
            { limit: 100, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, maxLimit: 2 }
        )
        expect(result.data).toHaveLength(2)
        expect(result.meta.itemsPerPage).toBe(2)
    })

    it('uses a config scope together with caller filters', async () => {
        const result = await paginate<Doctor>(
            { filter: { verificationStatus: 'pending' }, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, where: { firstName: 'Alice' } }
        )
        expect(result.data.map((row) => row.id)).toEqual([3, 1])
        expect(result.meta.totalItems).toBe(2)
    })

    it('treats an array of config where clauses as OR', async () => {
        const result = await paginate<Doctor>(
            { path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            {
                ...config,
                where: [{ verificationStatus: 'verified' }, { verificationStatus: 'rejected' }],
            }
        )
        expect(result.data.map((row) => row.id)).toEqual([4, 2])
    })

    it('rejects disallowed filters by default', async () => {
        await expect(
            paginate<Doctor>(
                { filter: { firstName: 'Alice' }, path: 'http://localhost/admin/doctors' },
                orm.em.getRepository(Doctor),
                config
            )
        ).rejects.toThrow("Column 'firstName' is not filterable")
    })

    it('can ignore disallowed filters explicitly', async () => {
        const result = await paginate<Doctor>(
            { filter: { firstName: 'Alice' }, path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            { ...config, throwOnInvalidFilter: false }
        )
        expect(result.meta.totalItems).toBe(4)
    })

    it('rejects disallowed filters when strict', async () => {
        await expect(
            paginate<Doctor>(
                { filter: { firstName: 'Alice' }, path: 'http://localhost/admin/doctors' },
                orm.em.getRepository(Doctor),
                { ...config, throwOnInvalidFilter: true }
            )
        ).rejects.toThrow()
    })

    it('uses only allow-listed sorting columns', async () => {
        const result = await paginate<Doctor>(
            { sortBy: [['firstName', 'ASC']], path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual([4, 3, 2, 1])
        expect(result.meta.sortBy).toEqual(config.defaultSortBy)
    })

    it('preserves an explicit descending sort', async () => {
        const result = await paginate<Doctor>(
            { sortBy: [['lastName', 'DESC']], path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            config
        )
        expect(result.data.map((row) => row.id)).toEqual([4, 3, 2, 1])
        expect(result.meta.sortBy).toEqual([['lastName', 'DESC']])
    })

    it('applies an inner join strategy to configured relations', async () => {
        const result = await paginate<Doctor>(
            { path: 'http://localhost/admin/doctors' },
            orm.em.getRepository(Doctor),
            {
                ...config,
                relations: { licenses: true },
                defaultJoinMethod: 'innerJoinAndSelect',
            }
        )
        expect(result.data.map((row) => row.id)).toEqual([4])
    })

    it('omits links for non-HTTP contexts', async () => {
        const result = await paginate<Doctor>({ limit: 2, path: null }, orm.em.getRepository(Doctor), config)
        expect(result.links).toEqual({})
    })
})
