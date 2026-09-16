(async () => {
    'use strict';

    /************************************************************
     * 犇站用户历史备份脚本
     *
     * 可以从任意用户、任意页启动，例如：
     *
     *   /user/377873/1
     *   /user/377873/23
     *   /user/123456/7
     *
     * 脚本会：
     *
     * 1. 自动识别 UID 和当前页；
     * 2. 从当前页开始抓取；
     * 3. 每条实际点击“查看 Markdown 源码”；
     * 4. 每抓完一页，在 Console 输出该页 JSON；
     * 5. 从当前 HTML 自动寻找下一页；
     * 6. HTML 中不存在更大的合法页码时，自动判定为最后一页；
     * 7. 最后输出总 JSON，并自动下载。
     *
     * 结果格式：
     *
     * {
     *   "data": [
     *     {
     *       "id": 8658090,
     *       "time": "发送于 2026/8/30 21:18:04，保存于 2026/8/30 21:18:30",
     *       "info": "Markdown 源码..."
     *     }
     *   ]
     * }
     ************************************************************/

    /**
     * 从当前页面地址自动识别 UID 和当前页。
     */
    function detectUserAndPage() {
        const m = location.pathname.match(
            /^\/user\/(\d+)\/(\d+)\/?$/
        );

        if (!m) {
            throw new Error(
                '当前页面地址不是 /user/UID/页码 的格式。'
            );
        }

        return {
            uid: m[1],
            page: Number(m[2])
        };
    }

    const initial = detectUserAndPage();

    const UID = initial.uid;
    const START_PAGE = initial.page;

    // true = 完成后自动保存 JSON 文件到本地。
    const DOWNLOAD_FINAL_JSON = true;

    // 点击后留一点时间给 Svelte 更新。
    // 不建议调得特别小。
    const ITEM_DELAY_MIN = 80;
    const ITEM_DELAY_MAX = 160;
    const PAGE_DELAY_MIN = 250;
    const PAGE_DELAY_MAX = 500;

    // 最终全部数据。
    const allData = [];

    // 随时可以在 Console 输入：
    //
    // window.__BENBEN_STOP__ = true
    //
    // 请求脚本在当前步骤结束后停止。
    window.__BENBEN_STOP__ = false;

    const sleep = ms =>
        new Promise(resolve => setTimeout(resolve, ms));

    const randomSleep = (min, max) =>
        sleep(Math.floor(min + Math.random() * (max - min + 1)));

    /**
     * 等待某个条件成立。
     * fn 返回 false/null/undefined 时继续等；
     * 返回其它值时 resolve 该值。
     */
    async function waitFor(fn, timeout = 10000, interval = 40) {
        const begin = Date.now();

        while (Date.now() - begin < timeout) {
            const result = fn();

            if (result) {
                return result;
            }

            await sleep(interval);
        }

        throw new Error(`等待页面更新超时（${timeout} ms）`);
    }

    /**
     * 当前处于第几页。
     */
    function getCurrentPage() {
        const m = location.pathname.match(
            new RegExp(`^/user/${UID}/(\\d+)/?$`)
        );

        return m ? Number(m[1]) : null;
    }

    /**
     * 从一个 /feed/123456 链接中获得 feed id。
     */
    function getFeedIdFromLink(link) {
        if (!link) return null;

        const pathname = new URL(link.href, location.href).pathname;
        const m = pathname.match(/^\/feed\/(\d+)\/?$/);

        return m ? Number(m[1]) : null;
    }

    /**
     * 找到当前页面真正的所有犇犇卡片。
     *
     * 不直接用所有 .card，因为页面底部分页框等也是 card。
     * 这里用 /feed/xxxx 链接反向寻找所属 card。
     */
    function getFeedCards() {
        const result = [];
        const seen = new Set();

        const feedLinks = [
            ...document.querySelectorAll('a[href^="/feed/"]')
        ];

        for (const link of feedLinks) {
            if (!/^\/feed\/\d+\/?$/.test(
                new URL(link.href, location.href).pathname
            )) {
                continue;
            }

            const card = link.closest('.card');

            if (card && !seen.has(card)) {
                seen.add(card);
                result.push(card);
            }
        }

        return result;
    }

    /**
     * 找 Markdown 源码 dialog。
     */
    function getMarkdownDialog() {
        return [...document.querySelectorAll('dialog')].find(dialog => {
            const title = dialog.querySelector('h3');

            return title &&
                title.textContent.includes('Markdown 源码');
        }) || null;
    }

    /**
     * 关闭 Markdown dialog。
     */
    async function closeMarkdownDialog(dialog) {
        if (!dialog || !dialog.open) return;

        const closeButton = [...dialog.querySelectorAll('button')]
            .find(button =>
                button.textContent.trim().includes('关闭')
            );

        if (closeButton) {
            closeButton.click();
        } else {
            // 万一网页 DOM 稍微改变，还有原生 dialog.close() 兜底。
            dialog.close();
        }

        try {
            await waitFor(() => !dialog.open, 3000, 30);
        } catch {
            // 再兜底一次。
            try {
                dialog.close();
            } catch (_) {}
        }
    }

    /**
     * 读取一条犇犇。
     */
    async function readOneFeed(card, index, pageNumber) {
        const feedLink = [
            ...card.querySelectorAll('a[href^="/feed/"]')
        ].find(link =>
            /^\/feed\/\d+\/?$/.test(
                new URL(link.href, location.href).pathname
            )
        );

        if (!feedLink) {
            throw new Error(
                `第 ${pageNumber} 页第 ${index + 1} 条：找不到 feed ID`
            );
        }

        const id = getFeedIdFromLink(feedLink);

        if (id === null) {
            throw new Error(
                `第 ${pageNumber} 页第 ${index + 1} 条：feed ID 解析失败`
            );
        }

        /*
         * 时间。
         *
         * 原 DOM 类似：
         *
         * 发送于 2026/8/30 21:18:04，保存于
         *     2026/8/30 21:18:30
         *
         * 把 HTML 排版产生的空白压成普通一个空格。
         */
        const timeElement = [...card.querySelectorAll('span')]
            .find(el =>
                el.textContent.includes('发送于') &&
                el.textContent.includes('保存于')
            );

        if (!timeElement) {
            throw new Error(
                `#${id}：找不到发送/保存时间`
            );
        }

        const time = timeElement.textContent
            .replace(/\s+/g, ' ')
            .trim();

        /*
         * 找“查看 Markdown 源码”按钮。
         */
        const markdownButton = [...card.querySelectorAll('a')]
            .find(el =>
                el.textContent.includes('查看 Markdown 源码')
            );

        if (!markdownButton) {
            throw new Error(
                `#${id}：找不到“查看 Markdown 源码”按钮`
            );
        }

        /*
         * 最多尝试三次。
         */
        let lastError = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
            try {
                // 如果上一次有残留弹窗，先关掉。
                let dialog = getMarkdownDialog();

                if (dialog?.open) {
                    await closeMarkdownDialog(dialog);
                }

                markdownButton.scrollIntoView({
                    block: 'center',
                    inline: 'nearest'
                });

                await randomSleep(30, 70);

                /*
                 * 实际点击网页自己的“查看 Markdown 源码”。
                 */
                markdownButton.click();

                dialog = await waitFor(() => {
                    const d = getMarkdownDialog();

                    if (!d || !d.open) {
                        return false;
                    }

                    const code = d.querySelector('pre code');

                    if (!code) {
                        return false;
                    }

                    return d;
                }, 6000, 30);

                /*
                 * 给 Svelte 再两个渲染帧，
                 * 防止 dialog 已经 open，而 code 正在更新。
                 */
                await new Promise(requestAnimationFrame);
                await new Promise(requestAnimationFrame);
                await sleep(60);

                const codeElement =
                    dialog.querySelector('pre code');

                if (!codeElement) {
                    throw new Error(
                        'Markdown 对话框没有 <pre><code>'
                    );
                }

                /*
                 * 保留真正的换行。
                 *
                 * JSON.stringify() 输出 JSON 时，
                 * 会自动将其表示为 \n。
                 */
                const info = codeElement.textContent
                    .replace(/\r\n?/g, '\n');

                await closeMarkdownDialog(dialog);

                return {
                    id,
                    time,
                    info
                };

            } catch (err) {
                lastError = err;

                console.warn(
                    `[犇站备份] #${id} 第 ${attempt}/3 次读取失败：`,
                    err
                );

                const dialog = getMarkdownDialog();

                if (dialog?.open) {
                    await closeMarkdownDialog(dialog);
                }

                await sleep(300);
            }
        }

        throw new Error(
            `#${id} 连续读取三次失败：` +
            `${lastError?.message || lastError}`
        );
    }

    /**
     * 获取当前页面第一条 feed ID，
     * 用于判断翻页后 DOM 是否真的换掉了。
     */
    function getFirstFeedId() {
        const cards = getFeedCards();

        if (!cards.length) return null;

        const link = [
            ...cards[0].querySelectorAll('a[href^="/feed/"]')
        ].find(link =>
            /^\/feed\/\d+\/?$/.test(
                new URL(link.href, location.href).pathname
            )
        );

        return getFeedIdFromLink(link);
    }

    /**
     * 智能寻找“下一页”。
     *
     * 不需要知道总页数。
     *
     * 方法：
     *
     * 1. 查看当前 HTML 中所有 <a>；
     * 2. 只接受 /user/当前UID/数字 形式的链接；
     * 3. 找出所有页码 > 当前页的链接；
     * 4. 取其中最小的页码。
     *
     * 例如当前第 1 页，HTML 中有：
     *
     *   1 2 3 4 5 62
     *
     * 则下一页是 2，而不是 62。
     *
     * 当前第 62 页时，不存在 > 62 的页码，
     * 返回 null，即判定为最后一页。
     */
    function getNextPageButton(currentPage) {
        const candidates = [];

        for (const a of document.querySelectorAll('a[href]')) {
            try {
                const pathname =
                    new URL(a.href, location.href).pathname;

                const m = pathname.match(
                    new RegExp(
                        `^/user/${UID}/(\\d+)/?$`
                    )
                );

                if (!m) {
                    continue;
                }

                const page = Number(m[1]);

                if (
                    Number.isInteger(page) &&
                    page > currentPage
                ) {
                    candidates.push({
                        element: a,
                        page
                    });
                }

            } catch (_) {}
        }

        if (!candidates.length) {
            return null;
        }

        candidates.sort(
            (a, b) => a.page - b.page
        );

        /*
         * 如果同一个页码出现多个链接，
         * 优先选分页按钮。
         */
        const nextPage = candidates[0].page;

        const samePageCandidates =
            candidates.filter(
                item => item.page === nextPage
            );

        const preferred =
            samePageCandidates.find(item =>
                item.element.classList.contains('join-item') &&
                item.element.classList.contains('btn')
            ) ||
            samePageCandidates.find(item =>
                item.element.closest('.sticky')
            ) ||
            samePageCandidates[0];

        return preferred;
    }

    /**
     * 模拟点击下一页页码按钮，并等待新页面完成渲染。
     */
    async function goToNextPage(currentPage, next) {
        const nextPage = next.page;
        const nextButton = next.element;

        const oldFirstId = getFirstFeedId();

        nextButton.scrollIntoView({
            block: 'center',
            inline: 'center'
        });

        await randomSleep(100, 220);

        console.log(
            `[犇站备份] 点击底部分页按钮：` +
            `${currentPage} → ${nextPage}`
        );

        /*
         * 真正点击网页元素。
         */
        nextButton.click();

        /*
         * 同时确认：
         *
         * 1. pathname 已经变成目标下一页；
         * 2. 当前页面有犇犇；
         * 3. 第一条 ID 已经和旧页面不一样。
         */
        await waitFor(() => {
            if (getCurrentPage() !== nextPage) {
                return false;
            }

            const cards = getFeedCards();

            if (!cards.length) {
                return false;
            }

            const newFirstId = getFirstFeedId();

            if (
                oldFirstId !== null &&
                newFirstId === oldFirstId
            ) {
                return false;
            }

            return true;
        }, 15000, 60);

        await randomSleep(
            PAGE_DELAY_MIN,
            PAGE_DELAY_MAX
        );
    }

    /**
     * 自动下载最终 JSON。
     */
    function downloadJSON(data) {
        const text = JSON.stringify(data, null, 2);

        const blob = new Blob(
            [text],
            {
                type: 'application/json;charset=utf-8'
            }
        );

        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');

        a.href = url;
        a.download =
            `benben-${UID}-from-page-${START_PAGE}.json`;

        document.body.appendChild(a);
        a.click();
        a.remove();

        setTimeout(() => {
            URL.revokeObjectURL(url);
        }, 5000);
    }


    /************************************************************
     * 正式开始
     ************************************************************/

    console.log(
        `[犇站备份] 开始备份 UID ${UID}，` +
        `从第 ${START_PAGE} 页开始。`
    );

    /*
     * 给你留几个全局变量。
     *
     * 脚本运行期间随时可在 Console 查看：
     *
     * window.__BENBEN_ALL__
     * window.__BENBEN_LAST_PAGE__
     */
    window.__BENBEN_ALL__ = {
        data: allData
    };

    window.__BENBEN_LAST_PAGE__ = null;

    let stopped = false;
    let pageNumber = START_PAGE;

    while (true) {
        if (window.__BENBEN_STOP__) {
            stopped = true;
            break;
        }

        /*
         * 确认确实位于目标页。
         */
        await waitFor(() => {
            return (
                getCurrentPage() === pageNumber &&
                getFeedCards().length > 0
            );
        }, 10000, 50);

        const cards = getFeedCards();

        console.log(
            `[犇站备份] 第 ${pageNumber} 页：` +
            `检测到 ${cards.length} 条犇犇。`
        );

        const pageData = [];

        for (let i = 0; i < cards.length; i++) {
            if (window.__BENBEN_STOP__) {
                stopped = true;
                break;
            }

            const item =
                await readOneFeed(
                    cards[i],
                    i,
                    pageNumber
                );

            pageData.push(item);
            allData.push(item);

            console.log(
                `[犇站备份] ` +
                `第 ${pageNumber} 页 ` +
                `${i + 1}/${cards.length}：` +
                `#${item.id}`
            );

            await randomSleep(
                ITEM_DELAY_MIN,
                ITEM_DELAY_MAX
            );
        }

        /*
         * 每页独立结果。
         */
        const pageResult = {
            page: pageNumber,
            data: pageData
        };

        window.__BENBEN_LAST_PAGE__ =
            pageResult;

        window.__BENBEN_ALL__ = {
            data: allData
        };

        console.log(
            `========== 第 ${pageNumber} 页 JSON ==========`
        );

        console.log(
            JSON.stringify(pageResult)
        );

        console.log(
            `========== 第 ${pageNumber} 页结束，` +
            `共 ${pageData.length} 条 ==========`
        );

        if (stopped) {
            break;
        }

        /*
         * 关键：
         *
         * 不再使用 LAST_PAGE。
         * 直接根据当前页面 HTML 判断是否还有更大页码。
         */
        const next =
            getNextPageButton(pageNumber);

        if (!next) {
            console.log(
                `[犇站备份] 当前第 ${pageNumber} 页中，` +
                `已经找不到更大的用户历史页码。`
            );

            console.log(
                `[犇站备份] 判定第 ${pageNumber} 页为最后一页。`
            );

            break;
        }

        /*
         * 正常情况下 next.page 就是 pageNumber + 1。
         *
         * 不过这里不强制要求连续，
         * 而是相信当前 HTML 中实际提供的最小更大页码。
         */
        await goToNextPage(
            pageNumber,
            next
        );

        pageNumber = next.page;
    }


    /************************************************************
     * 最终结果
     ************************************************************/

    const finalResult = {
        data: allData
    };

    window.__BENBEN_RESULT__ =
        finalResult;

    window.__BENBEN_RESULT_JSON__ =
        JSON.stringify(finalResult);

    console.log(
        '=================================================='
    );

    console.log(
        stopped
            ? '[犇站备份] 已按要求停止。下面是目前已取得的总 JSON：'
            : `[犇站备份] 全部完成，共取得 ${allData.length} 条犇犇。`
    );

    console.log(
        '================ 最终总 JSON ================'
    );

    console.log(
        JSON.stringify(finalResult)
    );

    console.log(
        '=================================================='
    );

    if (!stopped && DOWNLOAD_FINAL_JSON) {
        downloadJSON(finalResult);

        console.log(
            `[犇站备份] 已生成 ` +
            `benben-${UID}-from-page-${START_PAGE}.json`
        );
    }

})().catch(err => {
    console.error(
        '[犇站备份] 脚本异常停止：',
        err
    );

    console.error(
        '已经成功取得的数据仍保存在：' +
        'window.__BENBEN_ALL__'
    );

    console.error(
        '如需把当前已有结果转成 JSON：'
    );

    console.error(
        'JSON.stringify(window.__BENBEN_ALL__)'
    );
});
