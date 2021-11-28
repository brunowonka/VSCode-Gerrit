import {
	CommentController,
	CommentMode,
	comments,
	CommentThread,
	CommentThreadCollapsibleState,
	Disposable,
	Position,
	Range,
	Uri,
	window,
	workspace,
} from 'vscode';
import {
	GerritComment,
	GerritCommentBase,
	GerritDraftComment,
} from '../lib/gerritAPI/gerritComment';
import { DateSortDirection, DateTime } from '../lib/dateTime';
import { GerritCommentSide } from '../lib/gerritAPI/types';
import { GerritCommentThread } from './comments/thread';
import { FileProvider } from './fileProvider';
import { uniqueComplex } from '../lib/util';

export interface GerritCommentReply {
	text: string;
	thread: GerritCommentThread;
}

export interface NewlyCreatedGerritCommentReply {
	text: string;
	thread: CommentThread & Partial<GerritCommentThreadProps>;
}

interface GerritCommentThreadProps {
	resolved: boolean;
	comments: GerritCommentBase[];
}

export class DocumentCommentManager implements Disposable {
	public static _lastThreadId = 0;

	private _threadMap: Map<string, GerritCommentThread> = new Map();
	private _threadLineCount: Map<number, number> = new Map();

	public constructor(
		private readonly document: Uri,
		private readonly commentController: CommentController
	) {}

	public static getCommentRange(
		comment: Readonly<GerritCommentBase>
	): Range | null {
		if (comment.range) {
			return GerritComment.gerritRangeToVSCodeRange(comment.range);
		}
		if (comment.line) {
			return new Range(
				new Position(comment.line - 1, 0),
				new Position(comment.line - 1, 0)
			);
		}
		return null;
	}

	private _getAllRepliesTo(
		comment: GerritCommentBase,
		allComments: GerritCommentBase[]
	): GerritCommentBase[] {
		const replies: GerritCommentBase[] = [comment];
		const directReplies = allComments.filter(
			(c) => c.inReplyTo === comment.id
		);
		replies.push(...directReplies);
		for (const reply of directReplies) {
			replies.push(...this._getAllRepliesTo(reply, allComments));
		}
		return uniqueComplex(replies, (c) => c.id);
	}

	private _buildThreadsFromComments(
		comments: GerritCommentBase[]
	): GerritCommentBase[][] {
		return comments
			.filter((c) => !c.inReplyTo)
			.map((c) => this._getAllRepliesTo(c, comments))
			.map((t) =>
				DateTime.sortByDate(
					t,
					DateSortDirection.INCREASING_TIME,
					(c) => c.updated
				)
			);
	}

	public async loadComments(): Promise<this> {
		const fileMeta = FileProvider.tryGetFileMeta(this.document);
		if (!fileMeta) {
			return this;
		}

		const comments =
			(await GerritComment.getForMeta(fileMeta, this.document)).get(
				fileMeta.filePath
			) ?? [];
		const draftComments =
			(await GerritDraftComment.getForMeta(fileMeta, this.document)).get(
				fileMeta.filePath
			) ?? [];
		const allComments = [...comments, ...draftComments];
		const thisSideComments = allComments.filter(
			(c) => c.side ?? GerritCommentSide.RIGHT === fileMeta.side
		);
		const threads = this._buildThreadsFromComments(thisSideComments).filter(
			(t) => t.length !== 0
		);
		for (const thread of threads) {
			const line =
				DocumentCommentManager.getCommentRange(thread[0])?.start.line ??
				-1;
			this._threadLineCount.set(
				line,
				(this._threadLineCount.get(line) ?? 0) + 1
			);
		}
		for (const thread of threads) {
			const commentThread = this.createCommentThread(thread);
			if (commentThread) {
				thread.forEach((comment) => {
					this._threadMap.set(comment.id, commentThread);
				});
			}
		}
		return this;
	}

	public registerComments(
		thread: GerritCommentThread,
		...comments: GerritCommentBase[]
	): void {
		for (const comment of comments) {
			this._threadMap.set(comment.id, thread);
		}
	}

	public registerNewThread(thread: GerritCommentThread): void {
		for (const comment of thread.comments) {
			this._threadMap.set(comment.id, thread);
		}
	}

	public createCommentThread(
		comments: GerritCommentBase[]
	): GerritCommentThread | null {
		const range = DocumentCommentManager.getCommentRange(comments[0]);
		if (!range) {
			return null;
		}

		const vscodeThread = this.commentController.createCommentThread(
			this.document,
			range,
			comments
		) as CommentThread & Partial<GerritCommentThreadProps>;
		const thread = GerritCommentThread.from(vscodeThread);
		thread?.setComments(comments, true);
		return thread;
	}

	public getThreadByComment(
		comment: GerritCommentBase
	): GerritCommentThread | null {
		return this._threadMap.get(comment.id) ?? null;
	}

	public getLineThreadCount(lineNumber: number): number {
		return this._threadLineCount.get(lineNumber) ?? 0;
	}

	public collapseAll(): void {
		[...this._threadMap.values()].forEach((thread) => thread.collapse());
	}

	public dispose(): void {
		for (const thread of this._threadMap.values()) {
			thread.dispose();
		}
		this._threadMap.clear();
	}
}

export class CommentManager {
	private static readonly _commentController: CommentController =
		comments.createCommentController('gerrit', 'Gerrit');
	private static _disposables: Set<Disposable> = new Set();
	private static readonly _commentManagers: Map<
		string,
		DocumentCommentManager
	> = new Map();
	private static readonly _commentManagersByFilePath: Map<
		string,
		DocumentCommentManager[]
	> = new Map();

	public static init(): typeof CommentManager {
		this._disposables.add(
			workspace.onDidCloseTextDocument((doc) => {
				const meta = FileProvider.tryGetFileMeta(doc.uri);
				if (!meta) {
					return;
				}
				const key = FileProvider.fileMetaToKey(meta);
				if (this._commentManagers.has(key)) {
					this._commentManagers.get(key)!.dispose();
					this._commentManagers.delete(key);
				}
			})
		);
		this._commentController.commentingRangeProvider = {
			provideCommentingRanges: (document) => {
				// TODO: maybe do this when checked out as well?
				const meta = FileProvider.tryGetFileMeta(document.uri);
				if (meta) {
					const lineCount = document.lineCount;
					void (async () => {
						const manager = new DocumentCommentManager(
							document.uri,
							this._commentController
						);
						this._commentManagers.set(
							FileProvider.fileMetaToKey(meta),
							manager
						);
						if (
							!this._commentManagersByFilePath.has(meta.filePath)
						) {
							this._commentManagersByFilePath.set(
								meta.filePath,
								[]
							);
						}
						this._commentManagersByFilePath
							.get(meta.filePath)!
							.push(manager);
						await manager.loadComments();
					})();
					return [new Range(0, 0, lineCount - 1, 0)];
				}
				return null;
			},
		};
		return this;
	}

	public static getFileManagersForUri(uri: Uri): DocumentCommentManager[] {
		const meta = FileProvider.tryGetFileMeta(uri);
		if (!meta) {
			return [];
		}
		const managers = this._commentManagersByFilePath.get(meta.filePath);
		if (managers) {
			return managers;
		}

		// No need to load comments since we're creating this dynamically
		const manager = new DocumentCommentManager(
			uri,
			this._commentController
		);
		this._commentManagers.set(FileProvider.fileMetaToKey(meta), manager);
		return this._commentManagersByFilePath.get(meta.filePath) ?? [];
	}

	public static collapseAll(): void {
		const editor = window.activeTextEditor;
		if (!editor) {
			return;
		}

		const managers = this.getFileManagersForUri(editor.document.uri);
		for (const manager of managers) {
			manager.collapseAll();
		}
	}

	public static dispose(): void {
		this._commentController.dispose();
		this._disposables.forEach((d) => void d.dispose());
		this._commentManagers.forEach((m) => m.dispose());
		this._commentManagersByFilePath.forEach(
			(a) => void a.forEach((m) => void m.dispose())
		);
		this._disposables = new Set();
	}
}

async function createComment(
	thread: GerritCommentThread,
	text: string,
	isResolved: boolean,
	parentComment = thread.lastComment
): Promise<GerritDraftComment | null> {
	const meta = FileProvider.getFileMeta(thread.thread.uri);

	const newComment = await GerritComment.create({
		changeId: meta.changeId,
		content: text,
		filePath: meta.filePath,
		revision: meta.commit,
		unresolved: !isResolved,
		replyTo: parentComment?.id,
		lineOrRange: GerritComment.vsCodeRangeToGerritRange(
			thread.thread.range
		),
		side: meta.side,
		uri: thread.thread.uri,
	});
	if (!newComment) {
		await window.showErrorMessage('Failed to create comment');
		return null;
	}

	thread.pushComment(newComment, CommentThreadCollapsibleState.Expanded);
	return newComment;
}

async function updateComment(
	comment: GerritCommentBase,
	isResolved: boolean
): Promise<void> {
	if (comment.isDraft) {
		await (comment as GerritDraftComment).saveDraftMessage(isResolved);
		comment.mode = CommentMode.Preview;
		comment.thread?.expand();
	}
}

export async function saveComment(
	reply: NewlyCreatedGerritCommentReply | GerritCommentBase,
	isResolved: boolean
): Promise<void> {
	if (!reply.thread) {
		return;
	}

	if ('id' in reply) {
		await updateComment(reply, isResolved);
	} else {
		const thread = GerritCommentThread.from(reply.thread);
		if (!thread) {
			return;
		}
		await createComment(thread, reply.text, isResolved);
	}
}

export async function cancelComment(
	reply: NewlyCreatedGerritCommentReply | GerritCommentBase
): Promise<void> {
	if ('id' in reply) {
		await reply.updateInThread((comment) => {
			comment.mode = CommentMode.Preview;
		});
	} else {
		if (reply.thread.comments.length === 0) {
			reply.thread.dispose();
		}
	}
}

export async function setCommentResolved(
	reply: NewlyCreatedGerritCommentReply,
	isResolved: boolean
): Promise<void> {
	const gthread = GerritCommentThread.from(reply.thread);
	if (!gthread) {
		return;
	}
	await gthread.setResolved(isResolved);
}

export function collapseAllComments(): void {
	CommentManager.collapseAll();
}

export async function editComment(comment: GerritCommentBase): Promise<void> {
	await comment.updateInThread((c) => {
		c.mode = CommentMode.Editing;
	});
}

export async function deleteComment(comment: GerritCommentBase): Promise<void> {
	if (!comment.isDraft) {
		return;
	}
	await (comment as GerritDraftComment).delete();
}

export async function doneComment(comment: GerritCommentBase): Promise<void> {
	if (!comment.thread) {
		return;
	}
	await createComment(comment.thread, 'Done', true, comment);
}

export async function ackComment(comment: GerritCommentBase): Promise<void> {
	if (!comment.thread) {
		return;
	}
	await createComment(comment.thread, 'Ack', true, comment);
}