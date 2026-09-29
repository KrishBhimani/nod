import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cva, type VariantProps } from 'class-variance-authority';
import { LoaderCircle, Search, X } from 'lucide-react';
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
export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => (
  <textarea ref={ref} className={cn('input textarea', className)} {...props} />
));
Textarea.displayName = 'Textarea';
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
        <DialogPrimitive.Close
          className="button button-ghost button-icon dialog-close"
          aria-label="Close"
        >
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

export function SearchField({
  className,
  inputRef,
  onClear,
  clearLabel = 'Clear search',
  ...props
}: React.InputHTMLAttributes<HTMLInputElement> & {
  inputRef?: React.Ref<HTMLInputElement>;
  onClear?: () => void;
  clearLabel?: string;
}) {
  return (
    <label className={cn('search-field', className)}>
      <Search size={15} aria-hidden="true" />
      <Input ref={inputRef} {...props} />
      {onClear && props.value ? (
        <Button type="button" variant="ghost" size="icon" aria-label={clearLabel} onClick={onClear}>
          <X size={15} aria-hidden="true" />
        </Button>
      ) : null}
    </label>
  );
}
export function Switch({
  className,
  checked,
  onCheckedChange,
  ...props
}: Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'> & {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      className={cn('switch', className)}
      onClick={() => onCheckedChange(!checked)}
      {...props}
    >
      <span />
    </button>
  );
}
export function Checkbox({ className, ...props }: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input type="checkbox" className={cn('checkbox', className)} {...props} />;
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
  return (
    <div className="loading">
      <LoaderCircle size={17} className="spin" />
      <span>{label}</span>
    </div>
  );
}
