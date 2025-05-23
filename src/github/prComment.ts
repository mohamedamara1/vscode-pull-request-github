/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as path from 'path';
import * as vscode from 'vscode';
import { IComment } from '../common/comment';
import { emojify, ensureEmojis } from '../common/emoji';
import Logger from '../common/logger';
import { DataUri } from '../common/uri';
import { ALLOWED_USERS, JSDOC_NON_USERS, PHPDOC_NON_USERS } from '../common/user';
import { stringReplaceAsync } from '../common/utils';
import { GitHubRepository } from './githubRepository';
import { IAccount } from './interface';
import { updateCommentReactions } from './utils';

export interface GHPRCommentThread extends vscode.CommentThread2 {
	gitHubThreadId: string;

	/**
	 * The uri of the document the thread has been created on.
	 */
	uri: vscode.Uri;

	/**
	 * The range the comment thread is located within the document. The thread icon will be shown
	 * at the first line of the range.
	 */
	range: vscode.Range | undefined;

	/**
	 * The ordered comments of the thread.
	 */
	comments: (GHPRComment | TemporaryComment)[];

	/**
	 * Whether the thread should be collapsed or expanded when opening the document.
	 * Defaults to Collapsed.
	 */
	collapsibleState: vscode.CommentThreadCollapsibleState;

	/**
	 * The optional human-readable label describing the [Comment Thread](#CommentThread)
	 */
	label?: string;

	canReply: boolean | vscode.CommentAuthorInformation;

	/**
	 * Whether the thread has been marked as resolved.
	 */
	state?: { resolved: vscode.CommentThreadState; applicability?: vscode.CommentThreadApplicability };

	reveal(comment?: vscode.Comment, options?: vscode.CommentThreadRevealOptions): Promise<void>;

	dispose: () => void;
}

export namespace GHPRCommentThread {
	export function is(value: any): value is GHPRCommentThread {
		return (value && (typeof (value as GHPRCommentThread).gitHubThreadId) === 'string');
	}
}

abstract class CommentBase implements vscode.Comment {
	public abstract commentId: undefined | string;

	/**
	 * The comment thread the comment is from
	 */
	public parent: GHPRCommentThread;

	/**
	 * The text of the comment as from GitHub
	 */
	public abstract get body(): string | vscode.MarkdownString;
	public abstract set body(body: string | vscode.MarkdownString);

	/**
	 * Whether the comment is in edit mode or not
	 */
	public mode: vscode.CommentMode;

	/**
	 * The author of the comment
	 */
	public abstract get author(): vscode.CommentAuthorInformation;

	/**
	 * The author of the comment, before any modifications we make for display purposes.
	 */
	public originalAuthor: vscode.CommentAuthorInformation;

	/**
	 * The label to display on the comment, 'Pending' or nothing
	 */
	public label: string | undefined;

	/**
	 * The list of reactions to the comment
	 */
	public reactions?: vscode.CommentReaction[] | undefined;

	/**
	 * The context value, used to determine whether the command should be visible/enabled based on clauses in package.json
	 */
	public contextValue: string;

	constructor(
		parent: GHPRCommentThread,
	) {
		this.parent = parent;
	}

	public abstract commentEditId(): number | string;

	startEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof CommentBase && cmt.commentEditId() === this.commentEditId()) {
				cmt.mode = vscode.CommentMode.Editing;
			}

			return cmt;
		});
	}

	protected abstract getCancelEditBody(): string | vscode.MarkdownString;
	protected abstract doSetBody(body: string | vscode.MarkdownString, refresh: boolean): Promise<void>;

	cancelEdit() {
		this.parent.comments = this.parent.comments.map(cmt => {
			if (cmt instanceof CommentBase && cmt.commentEditId() === this.commentEditId()) {
				cmt.mode = vscode.CommentMode.Preview;
				this.doSetBody(this.getCancelEditBody(), true);
			}

			return cmt;
		});
	}
}

/**
 * Used to optimistically render updates to comment threads. Temporary comments are immediately
 * set when a command is run, and then replaced with real data when the operation finishes.
 */
export class TemporaryComment extends CommentBase {
	public commentId: undefined;

	/**
	 * The id of the comment
	 */
	public id: number;

	/**
	 * If the temporary comment is in place for an edit, the original text value of the comment
	 */
	public originalBody?: string;

	static idPool = 0;

	constructor(
		parent: GHPRCommentThread,
		private input: string,
		isDraft: boolean,
		currentUser: IAccount,
		originalComment?: GHPRComment,
	) {
		super(parent);
		this.mode = vscode.CommentMode.Preview;
		this.originalAuthor = {
			name: currentUser.login,
			iconPath: currentUser.avatarUrl ? vscode.Uri.parse(`${currentUser.avatarUrl}&s=64`) : undefined,
		};
		this.label = isDraft ? vscode.l10n.t('Pending') : undefined;
		this.contextValue = 'temporary,canEdit,canDelete';
		this.originalBody = originalComment ? originalComment.rawComment.body : undefined;
		this.reactions = originalComment ? originalComment.reactions : undefined;
		this.id = TemporaryComment.idPool++;
	}

	protected async doSetBody(input: string | vscode.MarkdownString): Promise<void> {
		if (typeof input === 'string') {
			this.input = input;
		}
	}

	set body(input: string | vscode.MarkdownString) {
		this.doSetBody(input);
	}

	get body(): string | vscode.MarkdownString {
		return new vscode.MarkdownString(this.input);
	}

	get author(): vscode.CommentAuthorInformation {
		return this.originalAuthor;
	}

	commentEditId() {
		return this.id;
	}

	protected getCancelEditBody() {
		return this.originalBody || this.body;
	}
}

const SUGGESTION_EXPRESSION = /```suggestion(\u0020*(\r\n|\n))((?<suggestion>[\s\S]*?)(\r\n|\n))?```/;
const IMG_EXPRESSION = /<img .*src=['"](?<src>.+?)['"].*?>/g;

export class GHPRComment extends CommentBase {
	private static ID = 'GHPRComment';
	public commentId: string;
	public timestamp: Date;

	/**
	 * The complete comment data returned from GitHub
	 */
	public rawComment: IComment;

	private _rawBody: string | vscode.MarkdownString;
	private replacedBody: string;

	constructor(private readonly context: vscode.ExtensionContext, comment: IComment, parent: GHPRCommentThread, private readonly githubRepositories?: GitHubRepository[]) {
		super(parent);
		this.rawComment = comment;
		this.originalAuthor = {
			name: comment.user!.login,
			iconPath: comment.user && comment.user.avatarUrl ? vscode.Uri.parse(comment.user.avatarUrl) : undefined,
		};

		const avatarUrisPromise = comment.user ? DataUri.avatarCirclesAsImageDataUris(context, [comment.user], 28, 28) : Promise.resolve([]);
		this.doSetBody(comment.body, !comment.user).then(async () => { // only refresh if there's no user. If there's a user, we'll refresh in the then.
			const avatarUris = await avatarUrisPromise;
			if (avatarUris.length > 0) {
				this.author.iconPath = avatarUris[0];
			}
			this.refresh();
		});
		this.commentId = comment.id.toString();

		updateCommentReactions(this, comment.reactions);

		this.label = comment.isDraft ? vscode.l10n.t('Pending') : undefined;

		const contextValues: string[] = [];
		if (comment.canEdit) {
			contextValues.push('canEdit');
		}

		if (comment.canDelete) {
			contextValues.push('canDelete');
		}

		if (this.suggestion !== undefined) {
			contextValues.push('hasSuggestion');
		}

		this.contextValue = contextValues.join(',');
		this.timestamp = new Date(comment.createdAt);
	}

	get author(): vscode.CommentAuthorInformation {
		if (!this.rawComment.user?.specialDisplayName) {
			return this.originalAuthor;
		}
		return {
			name: this.rawComment.user.specialDisplayName,
			iconPath: this.originalAuthor.iconPath,
		};
	}

	update(comment: IComment) {
		const oldRawComment = this.rawComment;
		this.rawComment = comment;
		let refresh: boolean = false;

		if (updateCommentReactions(this, comment.reactions)) {
			refresh = true;
		}

		const oldLabel = this.label;
		this.label = comment.isDraft ? vscode.l10n.t('Pending') : undefined;
		if (this.label !== oldLabel) {
			refresh = true;
		}

		const contextValues: string[] = [];
		if (comment.canEdit) {
			contextValues.push('canEdit');
		}

		if (comment.canDelete) {
			contextValues.push('canDelete');
		}

		if (this.suggestion !== undefined) {
			contextValues.push('hasSuggestion');
		}

		const oldContextValue = this.contextValue;
		this.contextValue = contextValues.join(',');
		if (oldContextValue !== this.contextValue) {
			refresh = true;
		}

		// Set the comment body last as it will trigger an update if set.
		if (oldRawComment.body !== comment.body) {
			this.doSetBody(comment.body, true);
			refresh = false;
		}

		if (refresh) {
			this.refresh();
		}
	}

	private refresh() {
		// Self assign the comments to trigger an update of the comments in VS Code now that we have replaced the body.
		// eslint-disable-next-line no-self-assign
		this.parent.comments = this.parent.comments;
	}

	get suggestion(): string | undefined {
		const match = this.rawComment.body.match(SUGGESTION_EXPRESSION);
		const suggestionBody = match?.groups?.suggestion;
		if (match) {
			return suggestionBody ? suggestionBody : '';
		}
	}

	public commentEditId() {
		return this.commentId;
	}

	private replaceImg(body: string) {
		return body.replace(IMG_EXPRESSION, (_substring, _1, _2, _3, { src }) => {
			return `![image](${src})`;
		});
	}

	private replaceSuggestion(body: string) {
		return body.replace(new RegExp(SUGGESTION_EXPRESSION, 'g'), (_substring: string, ...args: any[]) => {
			return `***
Suggested change:
\`\`\`
${args[3] ?? ''}
\`\`\`
***`;
		});
	}

	private async createLocalFilePath(rootUri: vscode.Uri, fileSubPath: string, startLine: number, endLine: number): Promise<string | undefined> {
		const localFile = vscode.Uri.joinPath(rootUri, fileSubPath);
		try {
			const stat = await vscode.workspace.fs.stat(localFile);
			if (stat.type === vscode.FileType.File) {
				return `${localFile.with({ fragment: `${startLine}-${endLine}` }).toString()}`;
			}
		} catch (e) {
			return undefined;
		}
	}

	private async replacePermalink(body: string): Promise<string> {
		const githubRepositories = this.githubRepositories;
		if (!githubRepositories || githubRepositories.length === 0) {
			return body;
		}

		const expression = new RegExp(`https://github.com/(.+)/${githubRepositories[0].remote.repositoryName}/blob/([0-9a-f]{40})/(.*)#L([0-9]+)(-L([0-9]+))?`, 'g');
		return stringReplaceAsync(body, expression, async (match: string, owner: string, sha: string, file: string, start: string, _endGroup?: string, end?: string, index?: number) => {
			if (index && (index > 0) && (body.charAt(index - 1) === '(')) {
				return match;
			}
			const githubRepository = githubRepositories.find(repository => repository.remote.owner.toLocaleLowerCase() === owner.toLocaleLowerCase());
			if (!githubRepository) {
				return match;
			}
			const startLine = parseInt(start);
			const endLine = end ? parseInt(end) : startLine + 1;
			const lineContents = await githubRepository.getLines(sha, file, startLine, endLine);
			if (!lineContents) {
				return match;
			}
			const localFile = await this.createLocalFilePath(githubRepository.rootUri, file, startLine, endLine);
			const lineMessage = end ? `Lines ${startLine} to ${endLine} in \`${sha.substring(0, 7)}\`` : `Line ${startLine} in \`${sha.substring(0, 7)}\``;
			return `
***
[${file}](${localFile ?? match})${localFile ? ` ([view on GitHub](${match}))` : ''}

${lineMessage}
\`\`\`
${lineContents}
\`\`\`
***`;
		});
	}

	private replaceNewlines(body: string) {
		return body.replace(/(?<!\s)(\r\n|\n)/g, '  \n');
	}

	private postpendSpecialAuthorComment(body: string) {
		if (!this.rawComment.specialDisplayBodyPostfix) {
			return body;
		}
		return `${body}  \n\n_${this.rawComment.specialDisplayBodyPostfix}_`;
	}

	private async replaceBody(body: string | vscode.MarkdownString): Promise<string> {
		const emojiPromise = ensureEmojis(this.context);
		Logger.trace('Replace comment body', GHPRComment.ID);
		if (body instanceof vscode.MarkdownString) {
			const permalinkReplaced = await this.replacePermalink(body.value);
			return this.replaceImg(this.replaceSuggestion(permalinkReplaced));
		}
		const newLinesReplaced = this.replaceNewlines(body);
		const documentLanguage = (await vscode.workspace.openTextDocument(this.parent.uri)).languageId;
		const replacerRegex = new RegExp(`([^/\[\`]|^)@(${ALLOWED_USERS})`, 'g');
		// Replace user
		const linkified = newLinesReplaced.replace(replacerRegex, (substring, _1, _2, offset) => {
			// Do not try to replace user if there's a code block.
			if ((newLinesReplaced.substring(0, offset).match(/```/g)?.length ?? 0) % 2 === 1) {
				return substring;
			}
			// Do not try to replace user if it might already be part of a link
			if (substring.includes(']') || substring.includes(')')) {
				return substring;
			}

			const username = substring.substring(substring.startsWith('@') ? 1 : 2);
			if ((((documentLanguage === 'javascript') || (documentLanguage === 'typescript')) && JSDOC_NON_USERS.includes(username))
				|| ((documentLanguage === 'php') && PHPDOC_NON_USERS.includes(username))) {
				return substring;
			}
			return `${substring.startsWith('@') ? '' : substring.charAt(0)}[@${username}](${path.dirname(this.rawComment.user!.url)}/${username})`;
		});

		const permalinkReplaced = await this.replacePermalink(linkified);
		await emojiPromise;
		return this.postpendSpecialAuthorComment(emojify(this.replaceImg(this.replaceSuggestion(permalinkReplaced))));
	}

	protected async doSetBody(body: string | vscode.MarkdownString, refresh: boolean) {
		this._rawBody = body;
		const replacedBody = await this.replaceBody(body);

		if (replacedBody !== this.replacedBody) {
			this.replacedBody = replacedBody;
			if (refresh) {
				this.refresh();
			}
		}
	}

	set body(body: string | vscode.MarkdownString) {
		this.doSetBody(body, false);
	}

	get body(): string | vscode.MarkdownString {
		if (this.mode === vscode.CommentMode.Editing) {
			return this._rawBody;
		}
		return new vscode.MarkdownString(this.replacedBody);
	}

	protected getCancelEditBody() {
		return new vscode.MarkdownString(this.rawComment.body);
	}
}
