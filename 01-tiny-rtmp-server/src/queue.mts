type LinkedListNode<T,> = {
  elem: T;
  next: LinkedListNode<T> | null;
};

export default class Queue<T,> {
  private head: LinkedListNode<T> | null = null;
  private tail: LinkedListNode<T> | null = null;

  public empty(): boolean {
    return this.head == null;
  }

  public push(elem: T): void {
    const node = { elem, next: null };
    if (this.tail == null) {
      this.head = node;
    } else {
      this.tail.next = node;
    }
    this.tail = node;
  }

  public peek(): T | null {
    return this.head?.elem ?? null;
  }

  public pop(): T | null {
    const node = this.head;
    if (node == null) { return null; }

    // 付け替え
    this.head = node.next;
    if (this.head == null) { this.tail = null; }
    return node.elem;
  }
}
