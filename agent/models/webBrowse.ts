/**
 * Web browsing tools for Copix agents (Desktop + CLI).
 * No API keys — aggregates public search APIs + HTTP page fetch
 * (with Jina reader fallback for hard-to-read HTML).
 */

const UA =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 CopixAgent/1.0';

const MAX_SEARCH = 8;
const MAX_FETCH_CHARS = 12_000;
const FETCH_TIMEOUT_MS = 15_000;

export interface WebSearchHit {
	title: string;
	url: string;
	snippet: string;
	source?: string;
}

function decodeEntities(s: string): string {
	return s
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
		.replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

function stripTags(html: string): string {
	return decodeEntities(
		html
			.replace(/<script[\s\S]*?<\/script>/gi, ' ')
			.replace(/<style[\s\S]*?<\/style>/gi, ' ')
			.replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
			.replace(/<!--[\s\S]*?-->/g, ' ')
			.replace(/<br\s*\/?>/gi, '\n')
			.replace(/<\/(p|div|h[1-6]|li|tr|section|article)>/gi, '\n')
			.replace(/<[^>]+>/g, ' ')
			.replace(/[ \t]+\n/g, '\n')
			.replace(/\n{3,}/g, '\n\n')
			.replace(/[ \t]{2,}/g, ' ')
			.trim(),
	);
}

async function fetchText(url: string, init: RequestInit = {}): Promise<{ ok: boolean; status: number; text: string; url: string; ctype: string }> {
	const res = await fetch(url, {
		...init,
		headers: {
			'User-Agent': UA,
			Accept: 'text/html,application/xhtml+xml,application/json,text/plain;q=0.9,*/*;q=0.5',
			...(init.headers || {}),
		},
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		redirect: 'follow',
	});
	const text = await res.text();
	return {
		ok: res.ok,
		status: res.status,
		text,
		url: res.url || url,
		ctype: (res.headers.get('content-type') || '').toLowerCase(),
	};
}

function pushUnique(hits: WebSearchHit[], hit: WebSearchHit, limit: number) {
	if (hits.length >= limit) return;
	if (!hit.title || !hit.url) return;
	if (hits.some(h => h.url === hit.url)) return;
	hits.push(hit);
}

async function searchWikipedia(query: string, limit: number): Promise<WebSearchHit[]> {
	const url =
		`https://en.wikipedia.org/w/api.php?action=query&list=search&srsearch=${encodeURIComponent(query)}`
		+ `&utf8=1&format=json&srlimit=${Math.min(limit, 5)}`;
	const res = await fetchText(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) return [];
	try {
		const data = JSON.parse(res.text) as {
			query?: { search?: Array<{ title: string; snippet: string }> };
		};
		return (data.query?.search ?? []).map(item => ({
			title: item.title,
			url: `https://en.wikipedia.org/wiki/${encodeURIComponent(item.title.replace(/ /g, '_'))}`,
			snippet: stripTags(item.snippet || ''),
			source: 'wikipedia',
		}));
	} catch {
		return [];
	}
}

async function searchHackerNews(query: string, limit: number): Promise<WebSearchHit[]> {
	const url = `https://hn.algolia.com/api/v1/search?query=${encodeURIComponent(query)}&hitsPerPage=${Math.min(limit, 5)}`;
	const res = await fetchText(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) return [];
	try {
		const data = JSON.parse(res.text) as {
			hits?: Array<{ title?: string; url?: string; story_url?: string; story_text?: string; objectID?: string }>;
		};
		const out: WebSearchHit[] = [];
		for (const h of data.hits ?? []) {
			const link = h.url || h.story_url || (h.objectID ? `https://news.ycombinator.com/item?id=${h.objectID}` : '');
			pushUnique(out, {
				title: h.title || link,
				url: link,
				snippet: stripTags(h.story_text || '').slice(0, 220),
				source: 'hackernews',
			}, limit);
		}
		return out;
	} catch {
		return [];
	}
}

async function searchDuckDuckGoIA(query: string, limit: number): Promise<WebSearchHit[]> {
	const url =
		`https://api.duckduckgo.com/?q=${encodeURIComponent(query)}`
		+ '&format=json&no_redirect=1&no_html=1&skip_disambig=1';
	const res = await fetchText(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) return [];
	try {
		const data = JSON.parse(res.text) as {
			Heading?: string;
			AbstractText?: string;
			AbstractURL?: string;
			Results?: Array<{ Text?: string; FirstURL?: string }>;
			RelatedTopics?: Array<{ Text?: string; FirstURL?: string; Topics?: Array<{ Text?: string; FirstURL?: string }> }>;
		};
		const out: WebSearchHit[] = [];
		if (data.Heading && data.AbstractURL) {
			pushUnique(out, {
				title: data.Heading,
				url: data.AbstractURL,
				snippet: data.AbstractText || '',
				source: 'duckduckgo',
			}, limit);
		}
		for (const r of data.Results ?? []) {
			pushUnique(out, {
				title: stripTags(r.Text || r.FirstURL || ''),
				url: r.FirstURL || '',
				snippet: '',
				source: 'duckduckgo',
			}, limit);
		}
		const flatten = (topics: typeof data.RelatedTopics = []) => {
			for (const t of topics) {
				if (t.FirstURL && t.Text) {
					pushUnique(out, {
						title: stripTags(t.Text).split(' - ')[0] || t.Text,
						url: t.FirstURL,
						snippet: stripTags(t.Text),
						source: 'duckduckgo',
					}, limit);
				}
				if (t.Topics) flatten(t.Topics);
			}
		};
		flatten(data.RelatedTopics);
		return out;
	} catch {
		return [];
	}
}

async function searchNpm(query: string, limit: number): Promise<WebSearchHit[]> {
	// Only useful for package-ish queries — keep as a light supplement.
	if (!/\b(npm|package|node|react|vite|typescript|library|sdk)\b/i.test(query) && !query.includes('-')) {
		return [];
	}
	const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(query)}&size=${Math.min(limit, 4)}`;
	const res = await fetchText(url, { headers: { Accept: 'application/json' } });
	if (!res.ok) return [];
	try {
		const data = JSON.parse(res.text) as {
			objects?: Array<{ package?: { name?: string; description?: string; links?: { npm?: string; homepage?: string } } }>;
		};
		return (data.objects ?? []).map(o => ({
			title: o.package?.name || 'npm package',
			url: o.package?.links?.npm || o.package?.links?.homepage || `https://www.npmjs.com/package/${o.package?.name}`,
			snippet: o.package?.description || '',
			source: 'npm',
		}));
	} catch {
		return [];
	}
}

function formatHits(query: string, hits: WebSearchHit[]): string {
	if (!hits.length) return `No web results for: ${query}`;
	return hits
		.map((h, i) => {
			const snip = h.snippet ? `\n   ${h.snippet}` : '';
			const src = h.source ? ` (${h.source})` : '';
			return `${i + 1}. ${h.title}${src}\n   ${h.url}${snip}`;
		})
		.join('\n\n');
}

export async function webSearch(query: string, maxResults = 5): Promise<string> {
	const q = query.trim();
	if (!q) return 'web_search requires a non-empty query';
	const limit = Math.min(MAX_SEARCH, Math.max(1, maxResults | 0 || 5));

	const settled = await Promise.allSettled([
		searchDuckDuckGoIA(q, limit),
		searchWikipedia(q, limit),
		searchHackerNews(q, limit),
		searchNpm(q, Math.min(3, limit)),
	]);

	const hits: WebSearchHit[] = [];
	for (const s of settled) {
		if (s.status !== 'fulfilled') continue;
		for (const h of s.value) pushUnique(hits, h, limit);
	}

	return formatHits(q, hits.slice(0, limit));
}

function isBlockedUrl(url: string): string | null {
	let u: URL;
	try {
		u = new URL(url);
	} catch {
		return 'Invalid URL';
	}
	if (u.protocol !== 'http:' && u.protocol !== 'https:') {
		return `Unsupported protocol: ${u.protocol}`;
	}
	const host = u.hostname.toLowerCase();
	if (
		host === 'localhost'
		|| host.endsWith('.local')
		|| host === '0.0.0.0'
		|| host === '::1'
		|| /^127\./.test(host)
		|| /^10\./.test(host)
		|| /^192\.168\./.test(host)
		|| /^172\.(1[6-9]|2\d|3[0-1])\./.test(host)
		|| host === '169.254.169.254'
	) {
		return 'Refused: local / private network URLs are blocked';
	}
	return null;
}

async function fetchViaJina(url: string, budget: number): Promise<string | null> {
	try {
		const res = await fetchText(`https://r.jina.ai/${url}`, {
			headers: { Accept: 'text/plain' },
		});
		if (!res.ok || !res.text.trim()) return null;
		const body = res.text.length > budget
			? `${res.text.slice(0, budget)}\n…[truncated]`
			: res.text;
		return `URL: ${url}\nVia: jina.ai reader\n\n${body}`;
	} catch {
		return null;
	}
}

export async function webFetch(url: string, maxChars = MAX_FETCH_CHARS): Promise<string> {
	const raw = url.trim();
	if (!raw) return 'web_fetch requires a url';
	const blocked = isBlockedUrl(raw);
	if (blocked) return blocked;

	const budget = Math.min(MAX_FETCH_CHARS, Math.max(500, maxChars | 0 || MAX_FETCH_CHARS));

	try {
		const res = await fetchText(raw);
		if (!res.ok) {
			const viaJina = await fetchViaJina(raw, budget);
			if (viaJina) return viaJina;
			return `web_fetch failed: ${res.status} for ${raw}`;
		}

		const finalUrl = res.url || raw;
		const ctype = res.ctype;

		if (ctype.includes('application/json') || ctype.includes('text/json')) {
			const body = res.text.length > budget ? `${res.text.slice(0, budget)}\n…[truncated]` : res.text;
			return `URL: ${finalUrl}\nContent-Type: ${ctype}\n\n${body}`;
		}

		if (
			ctype
			&& !ctype.includes('text/')
			&& !ctype.includes('html')
			&& !ctype.includes('xml')
			&& !ctype.includes('json')
		) {
			const viaJina = await fetchViaJina(raw, budget);
			if (viaJina) return viaJina;
			return `URL: ${finalUrl}\nContent-Type: ${ctype}\n(binary or non-text content — not fetched as text)`;
		}

		const titleMatch = res.text.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
		const title = titleMatch ? stripTags(titleMatch[1]!).trim() : '';
		let text = stripTags(res.text);
		if (text.length < 80) {
			const viaJina = await fetchViaJina(raw, budget);
			if (viaJina) return viaJina;
		}
		if (text.length > budget) text = `${text.slice(0, budget)}\n…[truncated ${text.length - budget} chars]`;
		return [
			`URL: ${finalUrl}`,
			title ? `Title: ${title}` : null,
			'',
			text || '(empty page)',
		].filter(line => line !== null).join('\n');
	} catch (err) {
		const viaJina = await fetchViaJina(raw, budget);
		if (viaJina) return viaJina;
		return `web_fetch failed: ${err instanceof Error ? err.message : String(err)}`;
	}
}
