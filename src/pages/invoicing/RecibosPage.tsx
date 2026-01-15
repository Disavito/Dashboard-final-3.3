import { useState, useEffect } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2, Search, Download, FileText } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage, FormDescription } from '@/components/ui/form'; // FIX: Added FormDescription
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useToast } from '@/components/ui/use-toast';
import { ReciboPagoFormSchema, ReciboPagoFormValues } from '@/lib/types/invoicing';
import { fetchClientByDocument, fetchNextReceiptCorrelative, createIncomeFromBoleta, saveReceiptPdfToSupabase } from '@/lib/api/invoicingApi';
import { Client } from '@/lib/types/invoicing';
import { TablesInsert } from '@/lib/database.types';
import { format } from 'date-fns';
import { Checkbox } from '@/components/ui/checkbox';
import { Textarea } from '@/components/ui/textarea';
import { supabase } from '@/lib/supabaseClient';

const PAYMENT_METHODS = [
  { value: 'BBVA Empresa', label: 'BBVA Empresa' },
  { value: 'Efectivo', label: 'Efectivo' },
  { value: 'Cuenta Fidel', label: 'Cuenta Fidel' },
];

function RecibosPage() {
  const { toast } = useToast();
  const [isSearching, setIsSearching] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [correlative, setCorrelative] = useState('');
  const [clientData, setClientData] = useState<Client | null>(null);

  const form = useForm<ReciboPagoFormValues>({
    resolver: zodResolver(ReciboPagoFormSchema),
    defaultValues: {
      dni: '',
      client_name: '',
      client_id: null,
      fecha_emision: format(new Date(), 'yyyy-MM-dd'),
      monto: 250.00,
      concepto: 'Elaboracion de Expediente Tecnico',
      metodo_pago: 'Efectivo',
      numero_operacion: '',
      // NUEVOS VALORES POR DEFECTO
      is_payment_observed: false,
      payment_observation_detail: '',
    },
  });

  const dni = form.watch('dni');
  const metodoPago = form.watch('metodo_pago');
  const watchedIsPaymentObserved = form.watch('is_payment_observed');

  const loadCorrelative = async () => {
    try {
        const nextCorrelative = await fetchNextReceiptCorrelative();
        setCorrelative(nextCorrelative);
        return nextCorrelative;
    } catch (error) {
        console.error(error);
        toast({
          title: "Error de Correlativo",
          description: "No se pudo obtener el siguiente número de recibo (R-00xxx).",
          variant: "destructive",
        });
        return '';
    }
  };

  useEffect(() => {
    loadCorrelative();
  }, []);

  const handleDniSearch = async () => {
    if (!dni || dni.length !== 8) {
      toast({
        title: "DNI Inválido",
        description: "Ingrese un DNI de 8 dígitos.",
        variant: "warning",
      });
      return;
    }

    setIsSearching(true);
    setClientData(null);
    form.setValue('client_name', ''); 
    form.setValue('client_id', null);

    try {
      const client = await fetchClientByDocument(dni);
      
      if (client && client.id) {
        setClientData(client);
        form.setValue('client_name', client.razon_social);
        form.setValue('client_id', client.id);
        toast({
          title: "Socio Encontrado",
          description: `Datos cargados para: ${client.razon_social}`,
        });
      } else {
        toast({
          title: "Socio No Encontrado",
          description: "No se encontró un socio titular con ese DNI.",
          variant: "warning",
        });
      }
    } catch (error) {
      toast({
        title: "Error de Búsqueda",
        description: (error as Error).message,
        variant: "destructive",
      });
    } finally {
      setIsSearching(false);
    }
  };

  const onSubmit = async (values: ReciboPagoFormValues) => {
    if (!clientData || !clientData.id || !correlative) {
        toast({
            title: "Datos Incompletos",
            description: "Asegúrese de buscar y cargar los datos del socio y que el correlativo esté disponible.",
            variant: "destructive",
        });
        return;
    }

    setIsSubmitting(true);

    try {
        // 1. Preparar datos para el PDF (SOLO DATOS PÚBLICOS - EXCLUYE OBSERVACIÓN)
        const receiptData = {
            correlative: correlative,
            client_full_name: clientData.razon_social,
            client_dni: clientData.numero_documento,
            fecha_emision: values.fecha_emision,
            monto: values.monto,
            concepto: values.concepto,
            metodo_pago: values.metodo_pago,
            numero_operacion: values.numero_operacion,
            // Nota: is_payment_observed y payment_observation_detail se omiten intencionalmente para que no aparezcan en el PDF.
        };
        
        // 2. Cargar dinámicamente el generador de PDF y crear el Blob
        const { generateReceiptPdf } = await import('@/lib/receiptPdfGenerator');
        const pdfBlob = await generateReceiptPdf(receiptData);

        // 3. Guardar PDF en Supabase Storage y vincular en socio_documentos
        await saveReceiptPdfToSupabase(pdfBlob, correlative, clientData.id);

        // 4. Preparar datos para el registro de ingreso
        const incomeData: Omit<TablesInsert<'ingresos'>, 'id' | 'created_at'> = {
            receipt_number: correlative,
            dni: values.dni,
            full_name: clientData.razon_social,
            amount: values.monto,
            account: values.metodo_pago,
            date: values.fecha_emision,
            transaction_type: 'Recibo de Pago',
            numeroOperacion: values.metodo_pago === 'BBVA Empresa' ? Number(values.numero_operacion) : null,
        };

        // 5. Crear el registro de ingreso en la tabla 'ingresos'
        await createIncomeFromBoleta(incomeData);

        // 6. Actualizar estado de observación de pago del Socio Titular si se marcó la bandera (Lógica interna)
        if (values.is_payment_observed && clientData.id) {
            const { error: socioUpdateError } = await supabase
                .from('socio_titulares')
                .update({
                    is_payment_observed: true,
                    payment_observation_detail: values.payment_observation_detail || 'Observación de pago registrada durante la emisión del recibo.',
                })
                .eq('id', clientData.id);

            if (socioUpdateError) {
                console.error('Error updating socio payment observation:', socioUpdateError.message);
                toast({
                    title: "Advertencia de Observación",
                    description: "Ingreso registrado, pero falló la actualización de la observación de pago del socio.",
                    variant: "warning",
                });
            } else {
                toast({
                    title: "Socio Marcado como Observado",
                    description: `El socio ha sido marcado como Pago Observado internamente.`,
                    variant: "info",
                });
            }
        }

        // 7. Notificar éxito con acción de descarga
        toast({
            title: "Recibo Generado y Registrado",
            description: `El Recibo N° ${correlative} ha sido creado, guardado y el ingreso registrado.`,
            action: (
                <Button 
                    onClick={() => {
                        const url = window.URL.createObjectURL(pdfBlob);
                        const link = document.createElement('a');
                        link.href = url;
                        link.setAttribute('download', `${correlative}.pdf`);
                        document.body.appendChild(link);
                        link.click();
                        link.remove();
                        window.URL.revokeObjectURL(url);
                    }}
                    variant="secondary"
                    className="gap-2"
                >
                    <Download className="h-4 w-4" /> Descargar PDF
                </Button>
            ),
            duration: 8000,
        });

        // 8. Resetear el formulario y estado para el siguiente recibo
        form.reset({
            dni: '',
            client_name: '',
            client_id: null,
            fecha_emision: format(new Date(), 'yyyy-MM-dd'),
            monto: 250.00,
            concepto: 'Elaboracion de Expediente Tecnico',
            metodo_pago: 'Efectivo',
            numero_operacion: '',
            is_payment_observed: false,
            payment_observation_detail: '',
        });
        setClientData(null);
        loadCorrelative();

    } catch (error) {
        console.error("Error en el proceso de generación de recibo:", error);
        toast({
            title: "Error al Generar Recibo",
            description: (error as Error).message || "Ocurrió un error inesperado.",
            variant: "destructive",
        });
    } finally {
        setIsSubmitting(false);
    }
  };

  return (
    <div className="container mx-auto p-4 md:p-8 max-w-4xl">
      <header className="mb-8">
        <h1 className="text-4xl font-bold text-text tracking-tight">Generar Recibo de Pago Interno</h1>
        <p className="text-textSecondary mt-2">
          Emite un recibo de pago para socios. El número de recibo se genera automáticamente.
        </p>
      </header>

      <div className="bg-surface p-6 md:p-8 rounded-lg border border-border shadow-md">
        <div className="flex justify-between items-center mb-6 pb-4 border-b border-border">
            <h2 className="text-2xl font-semibold text-text">Formulario de Emisión</h2>
            <div className="text-right">
                <span className="text-sm text-textSecondary block">Número de Recibo</span>
                <span className="text-2xl font-bold text-primary">{correlative || <Loader2 className="h-6 w-6 animate-spin inline-block" />}</span>
            </div>
        </div>

        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
              <div className="md:col-span-2">
                <FormField
                  control={form.control}
                  name="dni"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>DNI del Socio Titular</FormLabel>
                      <div className="flex items-center gap-2">
                        <FormControl>
                          <Input placeholder="Buscar por DNI..." {...field} maxLength={8} />
                        </FormControl>
                        <Button type="button" onClick={handleDniSearch} disabled={isSearching || !dni || dni.length !== 8}>
                          {isSearching ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
                          <span className="ml-2 hidden sm:inline">Buscar</span>
                        </Button>
                      </div>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
              <div className="md:col-span-1">
                 <FormField
                  control={form.control}
                  name="fecha_emision"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Fecha de Emisión</FormLabel>
                      <FormControl>
                        <Input type="date" {...field} />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
              </div>
            </div>

            <FormField
              control={form.control}
              name="client_name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Nombre / Razón Social del Socio</FormLabel>
                  <FormControl>
                    <Input placeholder="El nombre se cargará automáticamente..." {...field} readOnly />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <FormField
                control={form.control}
                name="monto"
                render={({ field }) => (
                    <FormItem>
                    <FormLabel>Monto (S/.)</FormLabel>
                    <FormControl>
                        <Input type="number" step="0.01" placeholder="250.00" {...field} onChange={e => field.onChange(parseFloat(e.target.value))} />
                    </FormControl>
                    <FormMessage />
                    </FormItem>
                )}
                />
                <FormField
                control={form.control}
                name="metodo_pago"
                render={({ field }) => (
                    <FormItem>
                    <FormLabel>Método de Pago</FormLabel>
                    <Select onValueChange={field.onChange} defaultValue={field.value}>
                        <FormControl>
                        <SelectTrigger>
                            <SelectValue placeholder="Seleccione un método" />
                        </SelectTrigger>
                        </FormControl>
                        <SelectContent>
                        {PAYMENT_METHODS.map((method) => (
                            <SelectItem key={method.value} value={method.value}>
                            {method.label}
                            </SelectItem>
                        ))}
                        </SelectContent>
                    </Select>
                    <FormMessage />
                    </FormItem>
                )}
                />
            </div>

            <FormField
              control={form.control}
              name="concepto"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Concepto de Pago</FormLabel>
                  <FormControl>
                    <Input placeholder="Ej: Elaboración de Expediente Técnico" {...field} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />

            {metodoPago === 'BBVA Empresa' && (
                 <FormField
                    control={form.control}
                    name="numero_operacion"
                    render={({ field }) => (
                        <FormItem>
                        <FormLabel>Número de Operación</FormLabel>
                        <FormControl>
                            <Input placeholder="Ingrese el N° de operación del voucher" {...field} />
                        </FormControl>
                        <FormMessage />
                        </FormItem>
                    )}
                />
            )}
            
            {/* SECCIÓN DE OBSERVACIÓN DE PAGO */}
            <div className="pt-4 border-t border-border/50 space-y-4">
                <FormField
                    control={form.control}
                    name="is_payment_observed"
                    render={({ field }) => (
                        <FormItem className="flex flex-row items-start space-x-3 space-y-0 rounded-md p-2">
                            <FormControl>
                                <Checkbox
                                    checked={field.value}
                                    onCheckedChange={field.onChange}
                                    className="border-border data-[state=checked]:bg-warning data-[state=checked]:text-primary-foreground mt-1"
                                />
                            </FormControl>
                            <div className="space-y-1 leading-none">
                                <FormLabel className="text-warning font-semibold cursor-pointer">
                                    Marcar como Pago Observado (Interno)
                                </FormLabel>
                                <FormDescription className="text-textSecondary text-xs">
                                    Esto actualizará el estado del socio titular en el sistema.
                                </FormDescription>
                            </div>
                        </FormItem>
                    )}
                />

                {watchedIsPaymentObserved && (
                    <FormField
                        control={form.control}
                        name="payment_observation_detail"
                        render={({ field }) => (
                            <FormItem>
                                <FormLabel className="text-textSecondary">Detalle de la Observación</FormLabel>
                                <FormControl>
                                    <Textarea
                                        placeholder="Razón de la observación (ej: Pago realizado a cuenta incorrecta, monto incompleto)."
                                        className="min-h-[80px] border-warning/50 bg-background text-foreground focus:ring-warning focus:border-warning"
                                        {...field}
                                        value={field.value || ''}
                                    />
                                </FormControl>
                                <FormMessage />
                            </FormItem>
                        )}
                    />
                )}
            </div>
            {/* FIN SECCIÓN DE OBSERVACIÓN DE PAGO */}


            <div className="flex justify-end pt-6 border-t border-border">
                <Button 
                    type="submit" 
                    disabled={isSubmitting || !clientData || !correlative}
                    className="w-full md:w-auto gap-2"
                    size="lg"
                >
                  {isSubmitting ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileText className="h-5 w-5" />}
                  Generar y Registrar Recibo
                </Button>
            </div>
            {!clientData && (
                <p className="text-sm text-warning text-center mt-4">
                    Por favor, busque y seleccione un socio para poder generar el recibo.
                </p>
            )}
          </form>
        </Form>
      </div>
    </div>
  );
}

export default RecibosPage;
