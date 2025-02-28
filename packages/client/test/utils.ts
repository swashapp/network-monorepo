import crypto from 'crypto'
import { writeHeapSnapshot } from 'v8'
import { DependencyContainer } from 'tsyringe'

import { wait } from 'streamr-test-utils'
import { Wallet } from 'ethers'
import { PublishRequest, StreamMessage, SIDLike, SPID } from 'streamr-client-protocol'
import LeakDetector from 'jest-leak-detector'

import { StreamrClient } from '../src/StreamrClient'
import { counterId, CounterId, AggregatedError, instanceId } from '../src/utils'
import { Debug, format } from '../src/utils/log'
import { MaybeAsync } from '../src/types'
import { StreamProperties } from '../src/Stream'
import clientOptions from '../src/ConfigTest'

import Signal from '../src/utils/Signal'
import { PublishMetadata } from '../src/Publisher'
import { Pipeline } from '../src/utils/Pipeline'

export { clientOptions }

const testDebugRoot = Debug('test')
const testDebug = testDebugRoot.extend.bind(testDebugRoot)
export {
    testDebug as Debug
}

export function mockContext() {
    const id = counterId('mockContext')
    return { id, debug: testDebugRoot.extend(id) }
}

export const uid = (prefix?: string) => counterId(`p${process.pid}${prefix ? '-' + prefix : ''}`)

export function fakePrivateKey() {
    return crypto.randomBytes(32).toString('hex')
}

export function fakeAddress() {
    return crypto.randomBytes(32).toString('hex').slice(0, 40)
}

const TEST_REPEATS = (process.env.TEST_REPEATS) ? parseInt(process.env.TEST_REPEATS, 10) : 1

export function describeRepeats(msg: any, fn: any, describeFn = describe) {
    for (let k = 0; k < TEST_REPEATS; k++) {
        // eslint-disable-next-line no-loop-func
        describe(msg, () => {
            describeFn(`test repeat ${k + 1} of ${TEST_REPEATS}`, fn)
        })
    }
}

describeRepeats.skip = (msg: any, fn: any) => {
    describe.skip(`${msg} – test repeat ALL of ${TEST_REPEATS}`, fn)
}

describeRepeats.only = (msg: any, fn: any) => {
    describeRepeats(msg, fn, describe.only)
}

export async function collect(iterator: any, fn: MaybeAsync<(item: any) => void> = async () => {}) {
    const received: any[] = []
    for await (const msg of iterator) {
        received.push(msg.getParsedContent())
        await fn({
            msg, iterator, received,
        })
    }

    return received
}

export function getTestSetTimeout() {
    const addAfter = addAfterFn()
    return (callback: () => void, ms?: number) => {
        const t = setTimeout(callback, ms)
        addAfter(() => {
            clearTimeout(t)
        })
        return t
    }
}

export function addAfterFn() {
    const afterFns: any[] = []
    afterEach(async () => {
        const fns = afterFns.slice()
        afterFns.length = 0
        // @ts-expect-error
        AggregatedError.throwAllSettled(await Promise.allSettled(fns.map((fn) => fn())))
    })

    return (fn: any) => {
        afterFns.push(fn)
    }
}

export function Msg<T extends object>(opts?: T) {
    return {
        value: uid('msg'),
        ...opts,
    }
}

export type CreateMessageOpts = {
    /** index of message in total */
    index: number,
    /** batch number */
    batch: number,
    /** index of message in batch */
    batchIndex: number,
    /** total messages */
    total: number
}

export type PublishOpts = {
    testName: string,
    delay: number
    timeout: number
    /** set false to allow gc message content */
    retainMessages: boolean,
    waitForLast: boolean
    waitForLastCount: number
    waitForLastTimeout: number
    beforeEach: (m: any) => any
    afterEach: (msg: any, request: PublishRequest) => Promise<void> | void
    timestamp: number | (() => number)
    partitionKey: string
    createMessage: (opts: CreateMessageOpts) => Promise<any> | any
    batchSize: number
}

export const createMockAddress = () => '0x000000000000000000000000000' + Date.now()

export function getRandomClient() {
    const wallet = new Wallet(`0x100000000000000000000000000000000000000012300000001${Date.now()}`)
    return new StreamrClient({
        ...clientOptions,
        auth: {
            privateKey: wallet.privateKey
        }
    })
}

export const expectInvalidAddress = (operation: () => Promise<any>) => {
    return expect(() => operation()).rejects.toThrow()
}

// eslint-disable-next-line no-undef
const getTestName = (module: NodeModule) => {
    const fileNamePattern = new RegExp('.*/(.*).test\\...')
    const groups = module.filename.match(fileNamePattern)
    return (groups !== null) ? groups[1] : module.filename
}

const randomTestRunId = process.pid != null ? process.pid : crypto.randomBytes(4).toString('hex')

// eslint-disable-next-line no-undef
export const createRelativeTestStreamId = (module: NodeModule, suffix?: string) => {
    return counterId(`/test/${randomTestRunId}/${getTestName(module)}${(suffix !== undefined) ? '-' + suffix : ''}`, '-')
}

// eslint-disable-next-line no-undef
export const createTestStream = (streamrClient: StreamrClient, module: NodeModule, props?: Partial<StreamProperties>) => {
    return streamrClient.createStream({
        id: createRelativeTestStreamId(module),
        ...props
    })
}

export const getCreateClient = (defaultOpts = {}, defaultParentContainer?: DependencyContainer) => {
    const addAfter = addAfterFn()

    return function createClient(opts = {}, parentContainer?: DependencyContainer) {
        const c = new StreamrClient({
            ...clientOptions,
            auth: {
                privateKey: fakePrivateKey(),
            },
            ...defaultOpts,
            ...opts,
        }, defaultParentContainer ?? parentContainer)

        addAfter(async () => {
            await wait(0)
            if (!c) { return }
            c.debug('disconnecting after test >>')
            await c.destroy()
            c.debug('disconnecting after test <<')
        })

        return c
    }
}

/**
 * Write a heap snapshot file if WRITE_SNAPSHOTS env var is set.
 */
export function snapshot() {
    if (!process.env.WRITE_SNAPSHOTS) { return '' }
    testDebugRoot('heap snapshot >>')
    const value = writeHeapSnapshot()
    testDebugRoot('heap snapshot <<', value)
    return value
}

export class LeaksDetector {
    leakDetectors: Map<string, LeakDetector> = new Map()
    ignoredValues = new WeakSet()
    id = instanceId(this)
    debug = testDebug(this.id)

    // temporary whitelist leaks in network code
    ignoredKeys = new Set([
        '/cachedNode',
    ])

    private counter = CounterId(this.id)

    add(name: string, obj: any) {
        if (!obj || typeof obj !== 'object') { return }

        if (this.ignoredValues.has(obj)) { return }

        this.leakDetectors.set(name, new LeakDetector(obj))
    }

    ignore(obj: any) {
        if (!obj || typeof obj !== 'object') { return }
        this.ignoredValues.add(obj)
    }

    ignoreAll(obj: any) {
        if (!obj || typeof obj !== 'object') { return }
        const seen = new Set()
        this.walk([], obj, (_path, value) => {
            if (seen.has(value)) { return false }
            seen.add(value)
            this.ignore(value)
            return undefined
        })
    }

    idToPaths = new Map<string, Set<string>>() // ids to paths
    objectToId = new WeakMap<object, string>() // single id for value

    getID(path: string[], value: any) {
        if (this.objectToId.has(value)) {
            return this.objectToId.get(value)
        }

        let id = (() => {
            if (value.id) { return value.id }
            const pathString = path.join('/')
            const constructor = value.constructor?.name
            const type = constructor === 'Object' ? undefined : constructor
            return pathString + (type ? `-${type}` : '')
        })()

        id = this.counter(id)
        this.objectToId.set(value, id)
        return id
    }

    protected walk(
        path: string[],
        obj: object,
        fn: (path: string[], obj: object, depth: number) => false | void,
        depth = 0
    ) {
        if (!obj || typeof obj !== 'object') { return }

        if (depth > 10) { return }

        const doContinue = fn(path, obj, depth)

        if (doContinue === false) { return }

        if (Array.isArray(obj)) {
            obj.forEach((value, key) => {
                this.walk([...path, `${key}`], value, fn, depth + 1)
            })
            return
        }

        for (const [key, value] of Object.entries(obj)) {
            if (!value || typeof value !== 'object') { continue }

            this.walk([...path, `${key}`], value, fn, depth + 1)
        }
    }

    addAll(rootId: string, obj: object) {
        const seen = new Set()
        this.walk([rootId], obj, (path, value) => {
            if (this.ignoredValues.has(value)) { return false }
            const pathString = path.join('/')
            for (const key of this.ignoredKeys) {
                if (pathString.includes(key)) { return false } // stop walking
            }

            const id = this.getID(path, value)
            const paths = this.idToPaths.get(id) || new Set()
            paths.add(pathString)
            this.idToPaths.set(id, paths)
            if (!seen.has(value)) {
                seen.add(value)
                this.add(id, value)
            }
            return undefined
        })
    }

    async getLeaks() {
        this.debug('checking for leaks with %d items >>', this.leakDetectors.size)
        await wait(10) // wait a moment for gc to run?
        const outstanding = new Set<string>()
        const results = (await Promise.all([...this.leakDetectors.entries()].map(async ([key, d]) => {
            outstanding.add(key)
            const isLeaking = await d.isLeaking()
            outstanding.delete(key)
            return isLeaking ? key : undefined
        }))).filter(Boolean) as string[]

        const leaks = results.reduce((o, id) => Object.assign(o, {
            [id]: [...(this.idToPaths.get(id) || [])],
        }), {})

        this.debug('checking for leaks with %d items <<', this.leakDetectors.size)
        this.debug('%d leaks.', results.length)
        return leaks
    }

    async checkNoLeaks() {
        const leaks = await this.getLeaks()
        const numLeaks = Object.keys(leaks).length
        if (numLeaks) {
            throw new Error(format('Leaking %d of %d items: %o', numLeaks, this.leakDetectors.size, leaks))
        }
    }

    async checkNoLeaksFor(id: string) {
        const leaks = await this.getLeaks()
        const numLeaks = Object.keys(leaks).length
        if (Object.keys(leaks).includes(id)) {
            throw new Error(format('Leaking %d of %d items, including id %s: %o', numLeaks, this.leakDetectors.size, id, leaks))
        }
    }

    clear() {
        this.leakDetectors.clear()
    }
}

type PublishManyOpts = Partial<{
    delay: number,
    timestamp: number | (() => number)
    sequenceNumber: number | (() => number)
    partitionKey: number | string | (() => number | string)
    createMessage: (content: any) => any
}>

export async function* publishManyGenerator(
    total: number = 5,
    opts: PublishManyOpts = {}
): AsyncGenerator<PublishMetadata<any>> {
    const { delay = 10, sequenceNumber, timestamp, partitionKey, createMessage = Msg } = opts
    const batchId = counterId('publishMany')
    for (let i = 0; i < total; i++) {
        yield {
            timestamp: typeof timestamp === 'function' ? timestamp() : timestamp,
            sequenceNumber: typeof sequenceNumber === 'function' ? sequenceNumber() : sequenceNumber,
            partitionKey: typeof partitionKey === 'function' ? partitionKey() : partitionKey,
            content: createMessage({
                batchId,
                value: `${i + 1} of ${total}`,
                index: i,
                total,
            })
        }

        if (delay) {
            // eslint-disable-next-line no-await-in-loop
            await wait(delay)
        }
    }
}

type PublishTestMessageOptions = PublishManyOpts & {
    waitForLast?: boolean
    waitForLastCount?: number
    waitForLastTimeout?: number,
    retainMessages?: boolean
    onSourcePipeline?: Signal<[Pipeline<PublishMetadata<any>>]>
    onPublishPipeline?: Signal<[Pipeline<StreamMessage>]>
    afterEach?: (msg: StreamMessage) => Promise<void> | void
}

export function publishTestMessagesGenerator(client: StreamrClient, stream: SIDLike, maxMessages: number = 5, opts: PublishTestMessageOptions = {}) {
    const sid = SPID.parse(stream)
    const source = new Pipeline(publishManyGenerator(maxMessages, opts))
    if (opts.onSourcePipeline) {
        opts.onSourcePipeline.trigger(source)
    }
    const pipeline = new Pipeline<StreamMessage>(client.publisher.publishFromMetadata(sid, source))
    if (opts.afterEach) {
        pipeline.forEach(opts.afterEach)
    }
    return pipeline
}

export function getPublishTestStreamMessages(client: StreamrClient, stream: SIDLike, defaultOpts: PublishTestMessageOptions = {}) {
    const sid = SPID.parse(stream)
    return async (maxMessages: number = 5, opts: PublishTestMessageOptions = {}) => {
        const {
            waitForLast,
            waitForLastCount,
            waitForLastTimeout,
            retainMessages = true,
            ...options
        } = {
            ...defaultOpts,
            ...opts,
        }

        const contents = new WeakMap()
        client.publisher.streamMessageQueue.onMessage(([streamMessage]) => {
            contents.set(streamMessage, streamMessage.serializedContent)
        })
        const publishStream = publishTestMessagesGenerator(client, sid, maxMessages, options)
        client.onDestroy(() => {
            publishStream.return()
        })
        if (opts.onPublishPipeline) {
            opts.onPublishPipeline.trigger(publishStream)
        }
        const streamMessages = []
        let count = 0
        for await (const streamMessage of publishStream) {
            count += 1
            if (!retainMessages) {
                streamMessages.length = 0 // only keep last message
            }
            streamMessages.push(streamMessage)
            if (count === maxMessages) {
                break
            }
        }

        if (waitForLast) {
            await getWaitForStorage(client, {
                count: waitForLastCount,
                timeout: waitForLastTimeout,
            })(streamMessages[streamMessages.length - 1])
        }

        return streamMessages.map((streamMessage) => {
            const targetStreamMessage = streamMessage.clone()
            targetStreamMessage.serializedContent = contents.get(streamMessage)
            targetStreamMessage.encryptionType = 0
            targetStreamMessage.parsedContent = null
            targetStreamMessage.getParsedContent()
            return targetStreamMessage
        })
    }
}

export function getPublishTestMessages(client: StreamrClient, stream: SIDLike, defaultOpts: PublishTestMessageOptions = {}) {
    const sid = SPID.parse(stream)
    const publishTestStreamMessages = getPublishTestStreamMessages(client, sid, defaultOpts)
    return async (maxMessages: number = 5, opts: PublishTestMessageOptions = {}) => {
        const streamMessages = await publishTestStreamMessages(maxMessages, opts)
        return streamMessages.map((s) => s.getParsedContent())
    }
}

export function getWaitForStorage(client: StreamrClient, defaultOpts = {}) {
    return async (lastPublished: StreamMessage, opts = {}) => {
        return client.publisher.waitForStorage(lastPublished, {
            ...defaultOpts,
            ...opts,
        })
    }
}
