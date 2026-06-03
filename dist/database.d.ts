import { TaskRecord } from "./types.js";
export declare class TaskDatabase {
    private db;
    constructor(dbPath?: string);
    private resolveDbPath;
    private initializeDatabase;
    createTask(taskData: Omit<TaskRecord, "id" | "created_at" | "updated_at">): Promise<void>;
    getTask(taskId: string): Promise<TaskRecord | null>;
    updateTask(taskId: string, updates: Partial<TaskRecord>): Promise<void>;
    getAllTasks(limit?: number): Promise<TaskRecord[]>;
    getTasksByStatus(status: string, limit?: number): Promise<TaskRecord[]>;
    close(): Promise<void>;
}
