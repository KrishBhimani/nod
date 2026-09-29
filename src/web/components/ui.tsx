import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle, X } from 'lucide-react';
import { cn } from '../lib/utils';

const buttonVariants = cva('button', {
  variants: {
    variant: {
      default: 'button-primary',
      secondary: 'button-secondary',
      ghost: 'button-ghost',
      outline: 'button-outline',
      destructive: 'button-destructive',
    },
    size: { default: 'button-default', sm: 'button-sm', icon: 'button-icon' },
  },
  defaultVariants: { variant: 'default', size: 'default' },
});

export function Button({
  className,
  variant,
  size,
  asChild = false,
  ...props
}: React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Component = asChild ? Slot : 'button';
  return <Component className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(({ className, ...props }, ref) => (
  <input ref={ref} className={cn('input', className)} {...props} />
));
Input.displayName = 'Input';
export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogTitle = DialogPrimitive.Title;
export const DialogDescription = DialogPrimitive.Description;

export function DialogContent({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content>) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="dialog-overlay" />
      <DialogPrimitive.Content className={cn('dialog-content', className)} {...props}>
        {children}
        <DialogPrimitive.Close className="dialog-close" aria-label="Close">
          <X size={18} />
        </DialogPrimitive.Close>
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export function Field({
  label,
  children,
  hint,
}: {
  label: string;
  children: React.ReactNode;
  hint?: string;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function Notice({
  children,
  kind = 'error',
}: {
  children: React.ReactNode;
  kind?: 'error' | 'info' | 'success';
}) {
  return (
    <div className={cn('notice', `notice-${kind}`)} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }: { label?: string }) {
  React.useLayoutEffect(() => {
    const shown = performance.now();
    return () => {
      if (performance.now() - shown > 300) revealContent();
    };
  }, []);
  return (
    <div className="loading">
      <span className="loading-ghost" aria-hidden="true">
        {[58, 44, 51].map((width) => (
          <span key={width} className="resource-row">
            <Skeleton className="ghost-icon" />
            <span className="skeleton-lines">
              <Skeleton style={{ width: `${width}%` }} />
              <Skeleton style={{ width: `${width - 20}%` }} />
            </span>
          </span>
        ))}
      </span>
      <span className="loading-label">
        <LoaderCircle size={17} className="spin" />
        <span>{label}</span>
      </span>
    </div>
  );
}

let revealTimer: ReturnType<typeof setTimeout> | undefined;
function revealContent() {
  document.documentElement.dataset.reveal = 'true';
  clearTimeout(revealTimer);
  revealTimer = setTimeout(() => delete document.documentElement.dataset.reveal, 700);
}

export function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return <span aria-hidden="true" className={cn('skeleton', className)} {...props} />;
}
