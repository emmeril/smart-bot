class AsyncMutex {
    constructor() {
        this.locked = false;
        this.waiters = [];
    }

    isLocked() {
        return this.locked;
    }

    async acquire() {
        if (!this.locked) {
            this.locked = true;
            return this.release.bind(this);
        }

        return await new Promise((resolve) => {
            this.waiters.push(resolve);
        });
    }

    tryAcquire() {
        if (this.locked) return null;
        this.locked = true;
        return this.release.bind(this);
    }

    release() {
        const nextWaiter = this.waiters.shift();
        if (nextWaiter) {
            nextWaiter(this.release.bind(this));
            return;
        }
        this.locked = false;
    }

    async runExclusive(callback) {
        const release = await this.acquire();
        try {
            return await callback();
        } finally {
            release();
        }
    }

    async tryRunExclusive(callback, fallback = undefined) {
        const release = this.tryAcquire();
        if (!release) return typeof fallback === "function" ? fallback() : fallback;
        try {
            return await callback();
        } finally {
            release();
        }
    }
}

module.exports = { AsyncMutex };
