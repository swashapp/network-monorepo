import { instanceId } from './index'
import Gate from './Gate'
import { Debug, inspect } from './log'
import { Context, ContextError } from './Context'
import * as G from './GeneratorUtils'

export class PushBufferError extends ContextError {}

export const DEFAULT_BUFFER_SIZE = 256

function isError(err: any): err is Error {
    if (!err) { return false }

    if (err instanceof Error) { return true }

    return !!(
        err
        && err.stack
        && err.message
        && typeof err.stack === 'string'
        && typeof err.message === 'string'
    )
}

export type PushBufferOptions = {
    name?: string
}

export type IPushBuffer<InType, OutType = InType> = {
    push(item: InType): Promise<boolean>
    end(error?: Error): void
    endWrite(error?: Error): void
    length: number
    isFull(): boolean
    isDone(): boolean
    clear(): void
    collect(n?: number): Promise<OutType[]>
} & Context & AsyncGenerator<OutType>

/**
 * Implements an async buffer.
 * Push items into buffer, push will async block once buffer is full.
 * and will unblock once buffer has been consumed.
 */
export class PushBuffer<T> implements IPushBuffer<T>, Context {
    ['constructor']: typeof PushBuffer

    static Error = PushBufferError
    id
    debug

    protected readonly buffer: (T | Error)[] = []
    readonly bufferSize: number

    /** open when writable */
    protected readonly writeGate: Gate
    /** open when readable */
    protected readonly readGate: Gate

    protected error: Error | undefined
    protected iterator: AsyncGenerator<T>
    protected isIterating = false

    constructor(bufferSize = DEFAULT_BUFFER_SIZE, { name }: PushBufferOptions = {}) {
        this.id = instanceId(this, name)
        this.debug = Debug(this.id)

        if (!(bufferSize > 0 && Number.isSafeInteger(bufferSize))) {
            throw new PushBufferError(this, `bufferSize must be a safe positive integer, got: ${inspect(bufferSize)}`)
        }

        this.bufferSize = bufferSize
        // start both closed
        this.writeGate = new Gate(`${this.id}-write`)
        this.readGate = new Gate(`${this.id}-read`)
        this.writeGate.close()
        this.readGate.close()
        this.iterator = this.iterate()
        // this.debug('create', this.bufferSize)
    }

    /**
     * Puts item in buffer and opens readGate.
     * Blocks until writeGate is open again (or locked)
     * @returns Promise<true> if item was pushed, Promise<false> if done or became done before writeGate opened.
     */
    async push(item: T | Error) {
        if (!this.isWritable()) {
            return false
        }

        this.buffer.push(item)
        this.updateWriteGate()
        this.readGate.open()
        return this.writeGate.check()
    }

    map<NewOutType>(fn: G.GeneratorMap<T, NewOutType>) {
        const p = new PushBuffer<NewOutType>(this.bufferSize)
        pull(G.map(this, fn), p)
        return p
    }

    forEach(fn: G.GeneratorForEach<T>) {
        const p = new PushBuffer(this.bufferSize)
        pull(G.forEach(this, fn), p)
        return p
    }

    filter(fn: G.GeneratorFilter<T>) {
        const p = new PushBuffer(this.bufferSize)
        pull(G.filter(this, fn), p)
        return p
    }

    reduce<NewOutType>(fn: G.GeneratorReduce<T, NewOutType>, initialValue: NewOutType) {
        const p = new PushBuffer(this.bufferSize)
        pull(G.reduce(this, fn, initialValue), p)
        return p
    }

    /**
     * Collect n/all messages into an array.
     */
    async collect(n?: number) {
        if (this.isIterating) {
            throw new this.constructor.Error(this, 'Cannot collect if already iterating.')
        }
        return G.collect(this, n)
    }

    private updateWriteGate() {
        this.writeGate.setOpenState(!this.isFull())
    }

    /**
     * Immediate end of reading and writing
     * Buffer will not flush.
     */
    end(err?: Error) {
        if (err) {
            this.error = err
        }
        this.lock()
    }

    /**
     * Prevent further reads or writes.
     */
    lock() {
        this.writeGate.lock()
        this.readGate.lock()
    }

    /**
     * Prevent further writes.
     * Allows buffer to flush before ending.
     */
    endWrite(err?: Error) {
        if (err && !this.error) {
            this.error = err
        }

        this.readGate.open()
        this.writeGate.lock()
    }

    /**
     * True if buffered at least bufferSize items.
     * After this point, push will block until buffer is emptied again.
     */
    isFull() {
        return this.buffer.length >= this.bufferSize
    }

    /**
     * True if buffer has closed reads and writes.
     */
    isDone() {
        return this.writeGate.isLocked && this.readGate.isLocked
    }

    /**
     * Can't write if write gate locked.
     * No point writing if read gate is locked.
     */
    isWritable() {
        return !this.writeGate.isLocked && !this.readGate.isLocked
    }

    private async* iterate() {
        this.isIterating = true
        try {
            // if there's something buffered, we want to flush it
            while (!this.readGate.isLocked) {
                // keep reading off front of buffer until buffer empty
                while (this.buffer.length && !this.readGate.isLocked) {
                    const v = this.buffer.shift()!
                    // maybe open write gate
                    this.updateWriteGate()
                    if (isError(v)) {
                        throw v
                    }

                    yield v
                }
                if (this.buffer.length === 0 && this.writeGate.isLocked) {
                    break
                }

                if (this.isDone()) {
                    // buffer is empty and we're done
                    break
                }

                // buffer must be empty, close readGate until more writes.
                this.readGate.close()
                // wait for something to be written
                const ok = await this.readGate.check() // eslint-disable-line no-await-in-loop
                if (!ok) {
                    // no more reading
                    break
                }
            }

            const { error } = this
            if (error) {
                this.error = undefined
                throw error
            }
        } finally {
            this.buffer.length = 0
            this.lock()
        }
    }

    get length() {
        return this.buffer.length
    }

    // clears any pending items in buffer
    clear() {
        this.buffer.length = 0
    }

    // AsyncGenerator implementation

    async throw(err: Error) {
        this.endWrite(err)
        return this.iterator.throw(err)
    }

    async return(v?: T) {
        this.end()
        return this.iterator.return(v)
    }

    next() {
        return this.iterator.next()
    }

    async pull(src: AsyncGenerator<T>) {
        try {
            for await (const v of src) {
                const ok = await this.push(v)
                if (!ok || !this.isWritable()) { break }
            }
        } catch (err) {
            // this.endWrite(err)
        }
        this.endWrite()
    }

    [Symbol.asyncIterator]() {
        if (this.isIterating) {
            throw new this.constructor.Error(this, 'already iterating')
        }

        return this
    }
}

/**
 * Pull from a source into some PushBuffer
 */

export async function pull<InType, OutType = InType>(src: AsyncGenerator<InType>, dest: IPushBuffer<InType, OutType>) {
    if (!src) {
        throw new Error('no source')
    }

    try {
        for await (const v of src) {
            const ok = await dest.push(v)
            if (!ok) {
                break
            }
        }
    } catch (err) {
        dest.endWrite(err)
    } finally {
        dest.endWrite()
    }
}

export function flow<T>(asyncIterable: AsyncIterable<T>) {
    const consume = async () => {
        for await (const _ of asyncIterable) {
            // do nothing, just consume iterator
        }
    }

    // start consuming
    // note this function returns a promise but we want to prevent
    // unhandled rejections so can't use async keyword as this introduces
    // a new promise we can't attach a catch handler to.
    // anything awaiting this promise will still get the rejection
    // it just won't trigger unhandledrejection
    const task = consume()
    task.catch(() => {}) // prevent unhandled
    return task
}

/**
 * Pull from a source into self.
 */

export class PullBuffer<InType> extends PushBuffer<InType> {
    source: AsyncGenerator<InType>
    constructor(source: AsyncGenerator<InType>, ...args: ConstructorParameters<typeof PushBuffer>) {
        super(...args)
        this.source = source
        pull(this.source, this).catch(() => {
        })
    }

    map<NewOutType>(fn: G.GeneratorMap<InType, NewOutType>) {
        return new PullBuffer<NewOutType>(G.map(this, fn), this.bufferSize)
    }

    forEach(fn: G.GeneratorForEach<InType>) {
        return new PullBuffer(G.forEach(this, fn), this.bufferSize)
    }

    filter(fn: G.GeneratorFilter<InType>) {
        return new PullBuffer(G.filter(this, fn), this.bufferSize)
    }

    reduce<NewOutType>(fn: G.GeneratorReduce<InType, NewOutType>, initialValue: NewOutType) {
        return new PullBuffer(G.reduce(this, fn, initialValue), this.bufferSize)
    }
}
